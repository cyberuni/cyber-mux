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
						{ label: 'Pane', slug: 'concepts/pane' },
						{ label: 'Adapters', slug: 'concepts/adapters' },
						{ label: 'Detection', slug: 'concepts/detection' },
						{ label: 'Layouts', slug: 'concepts/layouts' },
						{ label: 'Worktrees', slug: 'concepts/worktrees' },
						{ label: 'AXI', slug: 'concepts/axi' },
					],
				},
				{
					label: 'CLI Reference',
					items: [
						{ label: 'Overview', slug: 'cli' },
						{ label: 'doctor', slug: 'cli/doctor' },
						{ label: 'mode', slug: 'cli/mode' },
						{ label: 'open', slug: 'cli/open' },
						{ label: 'send', slug: 'cli/send' },
						{ label: 'submit', slug: 'cli/submit' },
						{ label: 'read', slug: 'cli/read' },
						{ label: 'focus', slug: 'cli/focus' },
						{ label: 'close', slug: 'cli/close' },
						{ label: 'list', slug: 'cli/list' },
						{ label: 'exists', slug: 'cli/exists' },
						{ label: 'worktree', slug: 'cli/worktree' },
						{ label: 'layout', slug: 'cli/layout' },
					],
				},
			],
		}),
	],
})
