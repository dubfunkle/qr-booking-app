/** @type {import('tailwindcss').Config} */
module.exports = {
    content: [
      "./views/**/*.ejs",
      "./public/**/*.js"
    ],
    safelist: [
      'bg-orange-500',
      'bg-orange-600',
      'bg-orange-700',
      'hover:bg-orange-600',
      'hover:bg-orange-700',
      'from-orange-500',
      'to-orange-600',
      'bg-gradient-to-br',
      'text-white',
      'p-4',
      'rounded-md',
      'text-gray-800'
    ],    
    theme: {
      extend: {},
    },
    plugins: [],
  }
  