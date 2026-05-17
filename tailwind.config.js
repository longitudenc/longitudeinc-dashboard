/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#1F3864',
          light: '#2a4a7f',
          dark: '#162a4a',
        },
        accent: {
          DEFAULT: '#c8a800',
          light: '#f0cc00',
          dark: '#9a8000',
        },
        success: '#2d7a1a',
        warning: '#c8a800',
        danger: '#b83232',
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        display: ['var(--font-outfit)', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
