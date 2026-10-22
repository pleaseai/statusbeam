import nimbus, { defineConfig as defineNimbusConfig } from '@cloudflare/nimbus-docs'
import { tableScroll } from '@cloudflare/nimbus-docs/markdown'
import tailwindcss from '@tailwindcss/vite'
import icon from 'astro-icon'
import { defineConfig } from 'astro/config'

const nimbusConfig = defineNimbusConfig({
  // Absolute base URL. Required so canonical URLs, OG images, robots.txt,
  // the sitemap, and the AI-friendly outputs all emit absolute links.
  site: 'https://docs.statusbeam.dev',
  title: 'StatusBeam',
  description:
    'Open-source, CDN-native status page generator — a modern take on upptime.',
  locale: 'en',
  github: 'https://github.com/pleaseai/statusbeam',
  editPattern:
    'https://github.com/pleaseai/statusbeam/edit/main/apps/docs/{path}',
  socialImageAlt: 'StatusBeam documentation preview',
  head: [
    {
      tag: 'link',
      attrs: {
        rel: 'icon',
        type: 'image/svg+xml',
        href: '/favicon.svg',
      },
    },
  ],
  sidebar: {
    items: [
      {
        label: 'Getting Started',
        items: [
          'getting-started/introduction',
          'getting-started/quick-start',
        ],
      },
      {
        label: 'Guides',
        items: [
          'guides/configuration',
          'guides/deployment',
          'guides/emdash',
          'guides/private-pages',
        ],
      },
      {
        label: 'Reference',
        items: ['reference/ai-and-llms'],
      },
    ],
  },
})

export default defineConfig({
  output: 'static',
  // Serve bundled assets (`_astro/*` JS, CSS, fonts, images) from the Cloudflare
  // Pages project origin, decoupled from the page host. Pages are reached at `site`
  // (docs.statusbeam.dev — a custom domain on the same Pages project); their bundled
  // assets load from statusbeam-docs.pages.dev. Because that makes the module scripts
  // and @font-face cross-origin, the asset origin must send CORS — see public/_headers.
  // https://docs.astro.build/en/reference/configuration-reference/#buildassetsprefix
  build: {
    assetsPrefix: 'https://statusbeam-docs.pages.dev',
  },
  // Tailwind v4 via its Vite plugin (the integration Astro recommends for
  // Tailwind v4 — replaces the PostCSS plugin, which doesn't build under
  // Astro 7's Vite 8 bundler).
  vite: {
    plugins: [tailwindcss()],
  },
  // Hover-prefetch link targets so full-page navigations feel instant without
  // a client-side router.
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'hover',
  },
  integrations: [
    icon(),
    nimbus(nimbusConfig, {
      // Authoring rules are opt-in by design — your repo, your taste. The
      // two below are the load-bearing pair: frontmatter has to validate
      // against the content schema for the page to render properly, and
      // broken internal links are 404s for your readers. Add the others
      // (heading hierarchy, code-block language, style, etc.) when you're
      // ready to enforce them — see `nimbus-docs lint --help`.
      rules: {
        'nimbus/frontmatter-shape': 'error',
        'nimbus/internal-link': 'error',
      },
      // Wrap wide tables so they scroll instead of overflowing the page
      // (styled by `.nb-table-scroll` in src/styles/prose.css).
      markdown: {
        hastPlugins: [tableScroll()],
      },
    }),
  ],
})
