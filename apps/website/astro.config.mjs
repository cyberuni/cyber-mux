// @ts-check
import starlight from '@astrojs/starlight'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'astro/config'

export default defineConfig({
	site: 'https://cyberuni.github.io',
	base: '/cyber-mux/',
	vite: {
		plugins: [tailwindcss()],
	},
	integrations: [
		starlight({
			title: 'cyber-mux',
			description: 'Cross-multiplexer pane control — one contract over tmux, herdr, and WezTerm.',
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/cyberuni/cyber-mux' }],
			customCss: ['./src/styles/global.css'],
			sidebar: [
				{
					label: 'Getting Started',
					items: [{ label: 'Introduction', slug: 'getting-started/introduction' }],
				},
				{
					label: 'Concepts',
					items: [
						{ label: 'The mux seam', slug: 'concepts/mux-seam' },
						{ label: 'Adapters', slug: 'concepts/adapters' },
						{ label: 'Detection', slug: 'concepts/detection' },
						{ label: 'Layouts', slug: 'concepts/layouts' },
						{ label: 'Worktrees', slug: 'concepts/worktrees' },
						{ label: 'AXI', slug: 'concepts/axi' },
					],
				},
				{
					label: 'CLI Reference',
					items: [{ label: 'Commands', slug: 'cli/commands' }],
				},
			],
		}),
	],
})
