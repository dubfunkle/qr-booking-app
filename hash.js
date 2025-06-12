const bcrypt = require('bcrypt');

bcrypt.hash('test123', 10, (err, hash) => {
  if (err) throw err;
  console.log("🔐 Hashed password:", hash);
});
