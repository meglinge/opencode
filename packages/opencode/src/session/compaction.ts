import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import * as Session from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"
import * as Log from "@opencode-ai/core/util/log"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/storage"
import { ModelID, ProviderID } from "@/provider/schema"
import { Effect, Layer, Context, Schema } from "effect"
import * as DateTime from "effect/DateTime"
import { InstanceState } from "@/effect/instance-state"
import { isOverflow as overflow, usable } from "./overflow"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionEvent } from "@opencode-ai/core/session-event"
import { Usage } from "@opencode-ai/llm"
import { OpenAIResponses } from "@opencode-ai/llm/protocols/openai-responses"
import { ProviderTransform } from "@/provider/transform"
import { LLMNative } from "./llm/native-request"
import { isRecord } from "@/util/record"

const log = Log.create({ service: "session.compaction" })

export const Event = {
  Compacted: BusEvent.define(
    "session.compacted",
    Schema.Struct({
      sessionID: SessionID,
    }),
  ),
}

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const PRUNE_PROTECTED_TOOLS = ["skill"]
const DEFAULT_TAIL_TURNS = 2
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 8_000
const OPENAI_RESPONSES_COMPACTION_TEXT = "Context compacted with OpenAI Responses encrypted state."
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Do not mention the summary process or that context was compacted.`
type Turn = {
  start: number
  end: number
  id: MessageID
}

type Tail = {
  start: number
  id: MessageID
}

type CompletedCompaction = {
  userIndex: number
  assistantIndex: number
  summary: string | undefined
}

function summaryText(message: MessageV2.WithParts) {
  const text = message.parts
    .filter((part): part is MessageV2.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || undefined
}

function completedCompactions(messages: MessageV2.WithParts[]) {
  const users = new Map<MessageID, number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
    users.set(msg.info.id, i)
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant") return []
    if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
    const userIndex = users.get(msg.info.parentID)
    if (userIndex === undefined) return []
    return [{ userIndex, assistantIndex, summary: summaryText(msg) }]
  })
}

function buildPrompt(input: { previousSummary?: string; context: string[] }) {
  const anchor = input.previousSummary
    ? [
        "Update the anchored summary below using the conversation history above.",
        "Preserve still-true details, remove stale details, and merge in the new facts.",
        "<previous-summary>",
        input.previousSummary,
        "</previous-summary>",
      ].join("\n")
    : "Create a new anchored summary from the conversation history above."
  return [anchor, SUMMARY_TEMPLATE, ...input.context].join("\n\n")
}

function preserveRecentBudget(input: { cfg: Config.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

function supportsOpenAIResponsesCompaction(model: Provider.Model) {
  return model.providerID === ProviderID.openai && model.api.npm === "@ai-sdk/openai"
}

function providerHeaders(value: unknown) {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

function providerFetch(value: unknown) {
  return typeof value === "function" ? (value as typeof globalThis.fetch) : fetch
}

function openAIBaseURL(info: Provider.Info, model: Provider.Model) {
  if (typeof info.options.baseURL === "string" && info.options.baseURL.trim() !== "") return info.options.baseURL
  if (model.api.url) return model.api.url
  return OpenAIResponses.DEFAULT_BASE_URL
}

function openAIAPIKey(info: Provider.Info) {
  return typeof info.options.apiKey === "string" ? info.options.apiKey : info.key
}

function compactEndpoint(baseURL: string) {
  return `${baseURL.replace(/\/+$/, "")}/responses/compact`
}

function compactUsage(input: OpenAIResponses.OpenAIResponsesCompactResponse) {
  return new Usage({
    inputTokens: input.usage?.input_tokens,
    outputTokens: input.usage?.output_tokens,
    cacheReadInputTokens: input.usage?.input_tokens_details?.cached_tokens,
    reasoningTokens: input.usage?.output_tokens_details?.reasoning_tokens,
    totalTokens: input.usage?.total_tokens,
    providerMetadata: input.usage ? { openai: input.usage } : undefined,
  })
}

const decodeCompactResponseText = Schema.decodeUnknownEffect(Schema.fromJsonString(OpenAIResponses.OpenAIResponsesCompactResponse))

function turns(messages: MessageV2.WithParts[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
    })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }
  return result
}

function splitTurn(input: {
  messages: MessageV2.WithParts[]
  turn: Turn
  model: Provider.Model
  budget: number
  estimate: (input: { messages: MessageV2.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    for (let start = input.turn.start + 1; start < input.turn.end; start++) {
      const size = yield* input.estimate({
        messages: input.messages.slice(start, input.turn.end),
        model: input.model,
      })
      if (size > input.budget) continue
      return {
        start,
        id: input.messages[start]!.info.id,
      } satisfies Tail
    }
    return undefined
  })
}

export interface Interface {
  readonly isOverflow: (input: {
    tokens: MessageV2.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
  readonly process: (input: {
    parentID: MessageID
    messages: MessageV2.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderID; modelID: ModelID }
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: MessageV2.Assistant["tokens"]
      model: Provider.Model
    }) {
      return overflow({
        cfg: yield* config.get(),
        tokens: input.tokens,
        model: input.model,
        outputTokenMax: flags.outputTokenMax,
      })
    })

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: MessageV2.WithParts[]
      model: Provider.Model
    }) {
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      return Token.estimate(JSON.stringify(msgs))
    })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: MessageV2.WithParts[]
      cfg: Config.Info
      model: Provider.Model
    }) {
      const limit = input.cfg.compaction?.tail_turns ?? DEFAULT_TAIL_TURNS
      if (limit <= 0) return { head: input.messages, tail_start_id: undefined }
      const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
      const all = turns(input.messages)
      if (!all.length) return { head: input.messages, tail_start_id: undefined }
      const recent = all.slice(-limit)
      const sizes = yield* Effect.forEach(
        recent,
        (turn) =>
          estimate({
            messages: input.messages.slice(turn.start, turn.end),
            model: input.model,
          }),
        { concurrency: 1 },
      )

      let total = 0
      let keep: Tail | undefined
      for (let i = recent.length - 1; i >= 0; i--) {
        const turn = recent[i]!
        const size = sizes[i]
        if (total + size <= budget) {
          total += size
          keep = { start: turn.start, id: turn.id }
          continue
        }
        const remaining = budget - total
        const split = yield* splitTurn({
          messages: input.messages,
          turn,
          model: input.model,
          budget: remaining,
          estimate,
        })
        if (split) keep = split
        else if (!keep) log.info("tail fallback", { budget, size, total })
        break
      }

      if (!keep || keep.start === 0) return { head: input.messages, tail_start_id: undefined }
      return {
        head: input.messages.slice(0, keep.start),
        tail_start_id: keep.id,
      }
    })

    // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
    // calls, then erases output of older tool calls to free context space
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return
      log.info("pruning")

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      let total = 0
      let pruned = 0
      const toPrune: MessageV2.ToolPart[] = []
      let turns = 0

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "user") turns++
        if (turns < 2) continue
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
          if (part.state.time.compacted) break loop
          const estimate = Token.estimate(part.state.output)
          total += estimate
          if (total <= PRUNE_PROTECT) continue
          pruned += estimate
          toPrune.push(part)
        }
      }

      log.info("found", { pruned, total })
      if (pruned > PRUNE_MINIMUM) {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            part.state.time.compacted = Date.now()
            yield* session.updatePart(part)
          }
        }
        log.info("pruned", { count: toPrune.length })
      }
    })

    const createSummaryMessage = Effect.fn("SessionCompaction.createSummaryMessage")(function* (input: {
      parentID: MessageID
      sessionID: SessionID
      userMessage: MessageV2.User
      model: Provider.Model
    }) {
      const ctx = yield* InstanceState.context
      const message: MessageV2.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: input.parentID,
        sessionID: input.sessionID,
        mode: "compaction",
        agent: "compaction",
        variant: input.userMessage.model.variant,
        summary: true,
        path: {
          cwd: ctx.directory,
          root: ctx.worktree,
        },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: input.model.id,
        providerID: input.model.providerID,
        time: {
          created: Date.now(),
        },
      }
      return yield* session.updateMessage(message)
    })

    const publishCompacted = Effect.fn("SessionCompaction.publishCompacted")(function* (input: {
      sessionID: SessionID
      summary: string | undefined
      include: MessageID | undefined
    }) {
      if (flags.experimentalEventSystem) {
        yield* events.publish(SessionEvent.Compaction.Ended, {
          sessionID: input.sessionID,
          timestamp: DateTime.makeUnsafe(Date.now()),
          text: input.summary ?? "",
          include: input.include,
        })
      }
      yield* bus.publish(Event.Compacted, { sessionID: input.sessionID })
    })

    const autoContinue = Effect.fn("SessionCompaction.autoContinue")(function* (input: {
      sessionID: SessionID
      userMessage: MessageV2.User
      auto: boolean
      overflow?: boolean
      replay?: { info: MessageV2.User; parts: MessageV2.Part[] }
    }) {
      if (!input.auto) return
      if (input.replay) {
        const original = input.replay.info
        const replayMsg = yield* session.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: input.sessionID,
          time: { created: Date.now() },
          agent: original.agent,
          model: original.model,
          format: original.format,
          tools: original.tools,
          system: original.system,
        })
        for (const part of input.replay.parts) {
          if (part.type === "compaction") continue
          const replayPart =
            part.type === "file" && MessageV2.isMedia(part.mime)
              ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
              : part
          yield* session.updatePart({
            ...replayPart,
            id: PartID.ascending(),
            messageID: replayMsg.id,
            sessionID: input.sessionID,
          })
        }
        return
      }

      const info = yield* provider.getProvider(input.userMessage.model.providerID)
      if (
        !(yield* plugin.trigger(
          "experimental.compaction.autocontinue",
          {
            sessionID: input.sessionID,
            agent: input.userMessage.agent,
            model: yield* provider.getModel(input.userMessage.model.providerID, input.userMessage.model.modelID).pipe(Effect.orDie),
            provider: {
              source: info.source,
              info,
              options: info.options,
            },
            message: input.userMessage,
            overflow: input.overflow === true,
          },
          { enabled: true },
        )).enabled
      ) {
        return
      }

      const continueMsg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: input.sessionID,
        time: { created: Date.now() },
        agent: input.userMessage.agent,
        model: input.userMessage.model,
      })
      const text =
        (input.overflow
          ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
          : "") + "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: continueMsg.id,
        sessionID: input.sessionID,
        type: "text",
        // Internal marker for auto-compaction followups so provider plugins
        // can distinguish them from manual post-compaction user prompts.
        // This is not a stable plugin contract and may change or disappear.
        metadata: { compaction_continue: true },
        synthetic: true,
        text,
        time: {
          start: Date.now(),
          end: Date.now(),
        },
      })
    })

    const runOpenAIResponsesCompaction = Effect.fn("SessionCompaction.runOpenAIResponsesCompaction")(function* (input: {
      sessionID: SessionID
      messages: MessageV2.WithParts[]
      model: Provider.Model
    }) {
      if (!supportsOpenAIResponsesCompaction(input.model)) return undefined
      const info = yield* provider.getProvider(input.model.providerID)
      const apiKey = openAIAPIKey(info)
      if (!apiKey) return undefined

      const options = ProviderTransform.options({
        model: input.model,
        sessionID: input.sessionID,
        providerOptions: info.options,
      })
      const modelMessages = yield* MessageV2.toModelMessagesEffect(input.messages, input.model, {
        stripMedia: true,
        toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS,
      })
      const body = yield* OpenAIResponses.compactBody(
        LLMNative.request({
          model: input.model,
          apiKey,
          baseURL: openAIBaseURL(info, input.model),
          messages: ProviderTransform.message(modelMessages, input.model, options),
          providerOptions: ProviderTransform.providerOptions(input.model, options),
          headers: { ...providerHeaders(info.options.headers), ...input.model.headers },
        }),
      )
      const url = compactEndpoint(openAIBaseURL(info, input.model))
      const response = yield* Effect.tryPromise({
        try: () =>
          providerFetch(info.options.fetch)(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`,
              ...providerHeaders(info.options.headers),
              ...input.model.headers,
            },
            body: JSON.stringify(body),
          }),
        catch: (error) => new Error(`OpenAI Responses compaction request failed: ${String(error)}`),
      })
      const text = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (error) => new Error(`OpenAI Responses compaction response read failed: ${String(error)}`),
      })
      if (!response.ok) {
        return yield* Effect.fail(
          new Error(`OpenAI Responses compaction failed (${response.status} ${response.statusText}): ${text}`),
        )
      }
      return yield* decodeCompactResponseText(text)
    })

    const finishOpenAIResponsesCompaction = Effect.fn("SessionCompaction.finishOpenAIResponsesCompaction")(function* (input: {
      parentID: MessageID
      sessionID: SessionID
      userMessage: MessageV2.User
      model: Provider.Model
      compactionPart: MessageV2.CompactionPart | undefined
      compacted: OpenAIResponses.OpenAIResponsesCompactResponse
      auto: boolean
      overflow?: boolean
      replay?: { info: MessageV2.User; parts: MessageV2.Part[] }
    }) {
      const usage = Session.getUsage({ model: input.model, usage: compactUsage(input.compacted) })
      const message: MessageV2.Assistant = yield* createSummaryMessage(input)
      message.cost = usage.cost
      message.tokens = usage.tokens
      message.finish = "stop"
      message.time.completed = Date.now()
      yield* session.updateMessage(message)
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: message.id,
        sessionID: input.sessionID,
        type: "reasoning",
        text: "",
        metadata: {
          openai: {
            compactionOutput: input.compacted.output,
          },
        },
        time: { start: Date.now(), end: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        reason: "stop",
        messageID: message.id,
        sessionID: input.sessionID,
        type: "step-finish",
        tokens: usage.tokens,
        cost: usage.cost,
      })
      if (input.compactionPart) {
        yield* session.updatePart({
          ...input.compactionPart,
          method: "openai_responses",
          tail_start_id: undefined,
        })
      }
      yield* autoContinue(input)
      yield* publishCompacted({
        sessionID: input.sessionID,
        summary: OPENAI_RESPONSES_COMPACTION_TEXT,
        include: undefined,
      })
      return "continue" as const
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: MessageV2.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
    }) {
      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const compactionPart = parent.parts.find((part): part is MessageV2.CompactionPart => part.type === "compaction")

      let messages = input.messages
      let replay:
        | {
            info: MessageV2.User
            parts: MessageV2.Part[]
          }
        | undefined
      if (input.overflow) {
        const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
        for (let i = idx - 1; i >= 0; i--) {
          const msg = input.messages[i]
          if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
            replay = { info: msg.info, parts: msg.parts }
            messages = input.messages.slice(0, i)
            break
          }
        }
        const hasContent =
          replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
        if (!hasContent) {
          replay = undefined
          messages = input.messages
        }
      }

      const agent = yield* agents.get("compaction")
      const model = agent.model
        ? yield* provider.getModel(agent.model.providerID, agent.model.modelID).pipe(Effect.orDie)
        : yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID).pipe(Effect.orDie)
      const cfg = yield* config.get()
      const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      const prior = completedCompactions(history)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      const selected = yield* select({
        messages: history.filter((_, index) => !hidden.has(index)),
        cfg,
        model,
      })
      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      if (cfg.compaction?.openai_responses !== false) {
        const compacted = yield* runOpenAIResponsesCompaction({
          sessionID: input.sessionID,
          messages: history.filter((_, index) => !hidden.has(index)),
          model,
        }).pipe(
          Effect.catch((error: unknown) =>
            Effect.sync(() => log.warn("OpenAI Responses compaction failed; falling back", { error })).pipe(
              Effect.as(undefined),
            ),
          ),
        )
        if (compacted) {
          return yield* finishOpenAIResponsesCompaction({
            parentID: input.parentID,
            sessionID: input.sessionID,
            userMessage,
            model,
            compactionPart,
            compacted,
            auto: input.auto,
            overflow: input.overflow,
            replay,
          })
        }
      }
      const nextPrompt = compacting.prompt ?? buildPrompt({ previousSummary, context: compacting.context })
      const msgs = structuredClone(selected.head)
      yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
      const modelMessages = yield* MessageV2.toModelMessagesEffect(msgs, model, {
        stripMedia: true,
        toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS,
      })
      const msg = yield* createSummaryMessage({ parentID: input.parentID, sessionID: input.sessionID, userMessage, model })
      const processor = yield* processors.create({
        assistantMessage: msg,
        sessionID: input.sessionID,
        model,
      })
      const result = yield* processor.process({
        user: userMessage,
        agent,
        sessionID: input.sessionID,
        tools: {},
        system: [],
        messages: [
          ...modelMessages,
          {
            role: "user",
            content: [{ type: "text", text: nextPrompt }],
          },
        ],
        model,
      })

      if (result === "compact") {
        processor.message.error = new MessageV2.ContextOverflowError({
          message: replay
            ? "Conversation history too large to compact - exceeds model context limit"
            : "Session too large to compact - context exceeds model limit even after stripping media",
        }).toObject()
        processor.message.finish = "error"
        yield* session.updateMessage(processor.message)
        return "stop"
      }

      if (compactionPart && selected.tail_start_id && compactionPart.tail_start_id !== selected.tail_start_id) {
        yield* session.updatePart({
          ...compactionPart,
          tail_start_id: selected.tail_start_id,
        })
      }

      if (result === "continue") {
        yield* autoContinue({
          sessionID: input.sessionID,
          userMessage,
          auto: input.auto,
          overflow: input.overflow,
          replay,
        })
      }

      if (processor.message.error) return "stop"
      if (result === "continue") {
        const summary = summaryText(
          (yield* session.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)).find(
            (item) => item.info.id === msg.id,
          ) ?? {
            info: msg,
            parts: [],
          },
        )
        yield* publishCompacted({ sessionID: input.sessionID, summary, include: selected.tail_start_id })
      }
      return result
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderID; modelID: ModelID }
      auto: boolean
      overflow?: boolean
    }) {
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
      })
      if (flags.experimentalEventSystem) {
        yield* events.publish(SessionEvent.Compaction.Started, {
          sessionID: input.sessionID,
          timestamp: DateTime.makeUnsafe(Date.now()),
          reason: input.auto ? "auto" : "manual",
        })
      }
    })

    return Service.of({
      isOverflow,
      prune,
      process: processCompaction,
      create,
    })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(SessionProcessor.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(RuntimeFlags.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
  ),
)

export * as SessionCompaction from "./compaction"
