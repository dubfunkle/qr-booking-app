/** @type {import('tailwindcss').Config} */
module.exports = {
    content: [
      "./views/**/*.ejs",
      "./public/**/*.js"
    ],
    safelist: [
      'bg-red-500',
      'text-white',
      'p-4',
      'rounded-md',
      'text-gray-800',
      'bg-orange-500',
      'hover:bg-orange-600'
    ],
    theme: {
      extend: {},
    },
    plugins: [],
  }
  