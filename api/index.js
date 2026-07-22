const app = require('../app');

module.exports = (req, res) => {
  // Let Express handle the request/response directly
  app(req, res);
};
