/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0b0f17',
        panel: '#111827',
        edge: '#1f2937',
      },
    },
  },
  plugins: [],
};
