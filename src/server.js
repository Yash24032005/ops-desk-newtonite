const { app, processOutbox } = require('./app');
const { seed } = require('./db');
seed();
setInterval(() => processOutbox(), 2000);
const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`http://localhost:${port}`));
