/**
 * Hero ASCII-art blocks for Auggy marketing pages.
 * Rendered inside <ASCIIHero /> at text-[11px] leading-[1.05].
 *
 * Width guideline: keep under ~110ch so it doesn't overflow at md breakpoint.
 * Substitute with figlet output if a richer block is needed:
 *   `figlet -f ANSI_Shadow AUG1`
 *   `figlet -f Doom AUG1`
 *
 * The leading newline keeps top-padding from the surrounding section visible.
 */

export const aug1Hero = String.raw`
   █████╗  ██╗   ██╗  ██████╗  ██╗
  ██╔══██╗ ██║   ██║ ██╔════╝ ███║
  ███████║ ██║   ██║ ██║  ███╗ ██║
  ██╔══██║ ██║   ██║ ██║   ██║ ██║
  ██║  ██║ ╚██████╔╝ ╚██████╔╝ ██║
  ╚═╝  ╚═╝  ╚═════╝   ╚═════╝  ╚═╝
`

/**
 * Per-page ASCII titles. Use these on /product, /augments, etc.
 * Keep them short (one word, ~6 lines) so they pair with an H1 below.
 */

export const productHero = String.raw`
  ██╗  ██╗ ███████╗ ██████╗  ███╗   ██╗ ███████╗ ██╗
  ██║ ██╔╝ ██╔════╝ ██╔══██╗ ████╗  ██║ ██╔════╝ ██║
  █████╔╝  █████╗   ██████╔╝ ██╔██╗ ██║ █████╗   ██║
  ██╔═██╗  ██╔══╝   ██╔══██╗ ██║╚██╗██║ ██╔══╝   ██║
  ██║  ██╗ ███████╗ ██║  ██║ ██║ ╚████║ ███████╗ ███████╗
  ╚═╝  ╚═╝ ╚══════╝ ╚═╝  ╚═╝ ╚═╝  ╚═══╝ ╚══════╝ ╚══════╝
`

export const memoryHero = String.raw`
  ███╗   ███╗ ███████╗ ███╗   ███╗  ██████╗  ██████╗  ██╗   ██╗
  ████╗ ████║ ██╔════╝ ████╗ ████║ ██╔═══██╗ ██╔══██╗ ╚██╗ ██╔╝
  ██╔████╔██║ █████╗   ██╔████╔██║ ██║   ██║ ██████╔╝  ╚████╔╝
  ██║╚██╔╝██║ ██╔══╝   ██║╚██╔╝██║ ██║   ██║ ██╔══██╗   ╚██╔╝
  ██║ ╚═╝ ██║ ███████╗ ██║ ╚═╝ ██║ ╚██████╔╝ ██║  ██║    ██║
  ╚═╝     ╚═╝ ╚══════╝ ╚═╝     ╚═╝  ╚═════╝  ╚═╝  ╚═╝    ╚═╝
`
