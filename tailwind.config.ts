/** @type {import('tailwindcss').Config} */
export default {
    darkMode: 'class',
    content: [
      "./index.html",
      "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
      extend: {
        colors: {
          emerald: {
            400: '#34d399',
            500: '#10b981',
            600: '#059669',
            700: '#047857',
          },
          teal: {
            500: '#0d9488',
            600: '#0f766e',
          },
          dark: {
            900: '#1a1a1a',
            800: '#252525',
            700: '#333333',
            600: '#444444',
          },
        },
        fontFamily: {
          inter: ['Inter', 'sans-serif'],
          poppins: ['Poppins', 'sans-serif'],
        },
      },
    },
    plugins: [],
  }
