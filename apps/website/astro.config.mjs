// @ts-check
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://cyberuni.github.io",
  base: "/cyber-mux/",
  // Astro 7's native Markdown processor applies GitHub-Flavored Markdown by default for both `.md`
  // and `.mdx`, so pipe tables render the same in every page without an explicit remark-gfm plugin.
  // (The old `markdown.remarkPlugins: [remarkGfm]` workaround is deprecated in v7 and no longer needed.)
  vite: {
    plugins: [tailwindcss()],
  },
  integrations: [
    starlight({
      title: "cyber-mux",
      description:
        "Cross-multiplexer pane control — one contract over tmux, herdr, and WezTerm.",
      // The cyber-* family mark: a shared command reticle around a per-package glyph
      // (see docs/design/icon-system.md).
      //
      // The favicon self-themes: browser chrome follows the OS, so that one file
      // flips its own fill under `prefers-color-scheme` and needs no pair.
      //
      // The header logo cannot. Starlight switches on `data-theme`, which this site
      // defaults to dark independent of the OS — a single self-theming file renders
      // black on the dark header whenever the visitor's OS is set to light. So the
      // header ships as a pair and lets Starlight pick. The pair is also cropped
      // tighter than the favicon: the mark's outer margin is padding a favicon needs
      // to survive a tab strip, and padding that only shrinks it in the header.
      favicon: "/img/logo.svg",
      logo: {
        light: "./src/assets/logo-light.svg",
        dark: "./src/assets/logo-dark.svg",
        alt: "cyber-mux",
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/cyberuni/cyber-mux",
        },
      ],
      customCss: ["./src/styles/global.css"],
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Introduction", slug: "getting-started/introduction" },
          ],
        },
        {
          label: "Multiplexers",
          items: [{ label: "Overview", slug: "multiplexers" }],
        },
        {
          label: "Concepts",
          items: [
            { label: "Detection", slug: "concepts/detection" },
            { label: "Workspace", slug: "concepts/workspace" },
            { label: "Tab", slug: "concepts/tab" },
            { label: "Pane", slug: "concepts/pane" },
            { label: "Worktrees", slug: "concepts/worktrees" },
            { label: "Templates", slug: "concepts/templates" },
            { label: "AXI", slug: "concepts/axi" },
          ],
        },
        {
          label: "CLI Reference",
          items: [
            { label: "Overview", slug: "cli" },
            { label: "doctor", slug: "cli/doctor" },
            { label: "mode", slug: "cli/mode" },
            { label: "open", slug: "cli/open" },
            { label: "send", slug: "cli/send" },
            { label: "submit", slug: "cli/submit" },
            { label: "read", slug: "cli/read" },
            { label: "wait", slug: "cli/wait" },
            { label: "focus", slug: "cli/focus" },
            { label: "close", slug: "cli/close" },
            { label: "list", slug: "cli/list" },
            { label: "exists", slug: "cli/exists" },
            { label: "worktree", slug: "cli/worktree" },
            { label: "template", slug: "cli/template" },
          ],
        },
        {
          label: "Library API",
          items: [
            { label: "Overview", slug: "api" },
            { label: "MuxAdapter", slug: "api/mux-adapter" },
            { label: "nudge", slug: "api/nudge" },
            { label: "Detection", slug: "api/probe" },
            { label: "Worktree", slug: "api/worktree" },
            { label: "Template", slug: "api/template" },
          ],
        },
      ],
    }),
  ],
});
