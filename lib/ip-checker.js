/**
 * @file Token method is restricted to CI tools only. Check if the origin IP is allowed to submit the request
 */
'use strict';

var List = require('immutable').List;
var Promise = require('promise');

/**
 * @exports lib/ip-checker
 */

var IPChecker = {};

/**
 * @returns {Promise.<List.<String>>}
 */

IPChecker.check = function (ip) {
  return new Promise(function (resolve) {
    var errors = new List();
    const { Octokit } = require("@octokit/core");
    const dig = require('node-dig-dns');
    const ipRangeCheck = require("ip-range-check");
    const octokit = new Octokit({ auth: global.GH_TOKEN });
    const ghIp = octokit.request('GET /meta');
    const travisIp = dig(['+short', 'nat.travisci.net']);

    Promise.all([travisIp, ghIp]).then(values => {
      let allowedIPs = [];
      values.forEach(v => {
        if (v.data && v.data.actions) {
          allowedIPs = allowedIPs.concat(v.data.actions); // GH Actions
        } else {
          allowedIPs = allowedIPs.concat(v.split(/\r?\n/)); // travis-ci
        }
      });
      if (!ipRangeCheck(ip, allowedIPs)) {
        errors = errors.push('The token method is restricted to GitHub Actions and Travis CI only. If ' +
        'you want to submit a request outside these tools, please use the tar method.');
      }
      resolve(errors);
    })
    .catch(e => console.error(e));
  });
};

module.exports = IPChecker;
