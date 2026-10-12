const path = require('path');
const { tests } = require('@iobroker/testing');

// Run integration tests - mock adapter
tests.integration(path.join(__dirname, '..'));
