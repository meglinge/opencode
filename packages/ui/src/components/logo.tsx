import { type ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path data-slot="logo-logo-mark-shadow" d="M8 15L4 9V20H0V0H4L8 6L12 0H16V20H12V9L8 15Z" fill="var(--icon-weak-base)" />
      <path data-slot="logo-logo-mark-m" d="M4 20H0V0H4L8 6L12 0H16V20H12V8L8 14L4 8V20Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M40 75L20 45V100H0V0H20L40 30L60 0H80V100H60V45L40 75Z" fill="var(--icon-base)" />
      <path d="M20 100H0V0H20L40 30L60 0H80V100H60V40L40 70L20 40V100Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 234 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <text
        x="117"
        y="33"
        fill="var(--icon-strong-base)"
        font-family="var(--font-family-mono)"
        font-size="34"
        font-weight="700"
        letter-spacing="-1.2"
        text-anchor="middle"
      >
        megcode
      </text>
    </svg>
  )
}
