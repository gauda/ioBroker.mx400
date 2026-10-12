const path = require('path');
const { tests } = require('@iobroker/testing');

tests.unit(path.join(__dirname, '..'), {
    defineAdditionalTests() {
        // Add your own unit tests here
    }
});
