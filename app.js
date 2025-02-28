/**
 * @module
 * @file Configurate API endpoints and view pages.
 */

/* eslint-disable no-console */

'use strict';

console.log('Launching…');

var meta = require('./package.json');
var express = require('express');
var compression = require('compression');
var bodyParser = require('body-parser');
var multer = require('multer');
var path = require('path');
var Fs = require('fs');
var Map = require('immutable').Map;
const { v4: uuidv4 } = require('uuid');

var Job = require('./lib/job');
var Orchestrator = require('./lib/orchestrator');
var RequestState = require('./lib/request-state');
var SpecberusWrapper = require('./lib/specberus-wrapper');
var mailer = require('./lib/mailer');

var passport = require('passport');
var LdapAuth = require('ldapauth-fork');
var BasicStrategy = require('passport-http').BasicStrategy;

// Configuration file
let config = process.env.CONFIG || "config.js";
require("./" + config);
console.log("Loading config: " + config);

var app = express();
var requests = {};
var port = process.argv[4] || global.DEFAULT_PORT;
var argTempLocation = process.argv[2] || global.DEFAULT_TEMP_LOCATION;
var argHttpLocation = process.argv[3] || global.DEFAULT_HTTP_LOCATION;
var argResultLocation = process.argv[5] || global.DEFAULT_RESULT_LOCATION;

app.use(compression());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(corsHandler);
app.use(express.static('assets/'));
app.set('json spaces', 2);
app.set('trust proxy', true);

// Index Page
app.get('/', function (request, response) {
  response.sendFile(__dirname + '/views/index.html');
});

// New UI
app.get('/ui', function (request, response) {
  response.sendFile(__dirname + '/views/web-interface.html');
});

// API methods

app.get('/api/version', function (req, res) {
  res.send(meta.version);
});

app.get('/api/version-specberus', function (req, res) {
  res.send(SpecberusWrapper.version);
});

app.get('/api/status', function (req, res) {
  var id = req.query ? req.query.id : null;
  var file = argResultLocation + path.sep + id + '.json';

  if (id) {
    Fs.access(file, Fs.constants.F_OK, function (error) {
      if (!error)
        res.status(200).sendFile(file);
      else if (requests && requests[id])
          res.status(200).json(requests[id]);
      else
        res.status(404).send('No job found with ID “' + id + '”.');
    });
  }
  else res.status(400).send('Missing required parameter “ID”.');
});

function dumpJobResult(dest, result) {
  Fs.writeFile(dest, JSON.stringify(result, null, 2) + '\n', function (err) {
    if (err) return console.error(err);
  });
}

/**
 * @function processRequest
 * @description **Handler of user request.** Distinguish if the request contains a tar file or a link to manifest.
 * @param {Object} req
 * @param {Object} res
 * @param {Boolean} isTar whether request contains a tar file
 */
var processRequest = function (req, res, isTar) {
  const id = uuidv4();
  const decision = req.body ? req.body.decision : null;
  const url = (!isTar && req.body) ? req.body.url : null;
  const token = (req.body) ? req.body.token : null;
  const tar = (isTar) ? req.file : null;
  const user = req.user;
  const dryRun = Boolean(req.body && req.body['dry-run'] && /^true$/i.test(req.body['dry-run']));
  const ccEmail = req.body ? req.body.cc : null;

  if (!((url && token) || (tar && token) || (tar && user)) || !decision) {
    res.status(500).send(
      'Missing required parameters "url + token + decision",' +
      ' "tar + token + decision" or "tar + W3C credentials + decision".'
    );
  }
  else {
    const tempLocation = `${argTempLocation}/${id}/`;
    const httpLocation = `${argHttpLocation}/${id}/Overview.html`;

    requests[id] = {};
    requests[id]['id'] = id;
    if (isTar) requests[id]['tar'] = tar.originalname;
    else requests[id]['url'] = url;
    requests[id]['version'] = meta.version;
    requests[id]['version-specberus'] = SpecberusWrapper.version;
    requests[id]['decision'] = decision;
    let jobList = ['retrieve-resources', 'metadata', 'specberus', 'transition-checker', 'third-party-checker', 'publish', 'tr-install', 'update-tr-shortlink'];

    if (token) {
      jobList.unshift('ip-checker');
      jobList.splice(4, 0, 'token-checker');
    } else {
      // tar method with credentials
      jobList.splice(2, 0, 'user-checker');
    }

    if (dryRun)
      jobList.splice(jobList.indexOf('publish'));

    // create empty result placeholder in /api/status?id=xxx
    requests[id]['results'] = new RequestState(
                  '',
                  new Map(jobList.reduce(function (object, value) {
                    object[value] = new Job();
                    return object;
                  }, {}))
                );

    // Orchestrator: jobList executed.
    var orchestrator = new Orchestrator(
      url,
      tar,
      token,
      user,
      tempLocation,
      httpLocation,
      argResultLocation,
      req.ip
    );

    Orchestrator.iterate(
      function (state) {
        return orchestrator.next(state);
      },
      Orchestrator.hasFinished,
      function (state) {
        requests[id].results = state;
      },
      requests[id].results
    ).then(function (state) {
      console.log('[' + state.get('status').toUpperCase() + '] ' + url);
      dumpJobResult(argResultLocation + path.sep + id + '.json', requests[id]);
      if (dryRun)
        console.log('Dry-run: omitting e-mail notification');
      else {
        mailer.sendMessage(
          id,
          state,
          requests[id],
          url || tar.originalname,
          ccEmail
        );
      }
    }).done();

    res.status(202).send(id);
  }
};

passport.use(new BasicStrategy(
  function (username, password, done) {
    var opts = {
      url: global.LDAP_URL,
      bindDn: global.LDAP_BIND_DN.replace(/{{username}}/, username),
      bindCredentials: password,
      searchBase: global.LDAP_SEARCH_BASE,
      searchFilter: '(uid={{username}})',
      searchAttributes: ['memberOf'],
      cache: false
    };

    var ldap = new LdapAuth(opts);

    ldap.authenticate(username, password, function (err, user) {
      if (err) {
        console.log('LDAP auth error: %s', err);
      }
      done(null, user);
    });
  }
));

app.post('/api/request', function (req, res, next) {
  if (req.is('application/x-www-form-urlencoded')) { // URL + token method
    processRequest(req, res, false);
  }
  else if (req.is('multipart/form-data')) { // tar method
    next();
  }
  else {
    res.status(501)
       .send({ status: 'Form Content-Type not supported' });
  }
});

app.post(
  '/api/request',
  multer().single('tar'),
  function (req, res, next) {
    if (req.headers.authorization) { // basic authentication
      next();
    } else {
      processRequest(req, res, true); // token
    }
  }
);

app.post(
  '/api/request',
  passport.authenticate('basic', { session: false }),
  function (req, res) {
    processRequest(req, res, true);
  }
);

/**
* Add CORS headers to responses if the client is explicitly allowed.
*
* First, this ensures that the testbed page on the test server, listening on a different port, can GET and POST to Echidna.
* Most importantly, this is necessary to attend publication requests from third parties, eg GitHub.
*/

function corsHandler(req, res, next) {
  if (req && req.headers && req.headers.origin) {
    if (global.ALLOWED_CLIENTS.some(function (regex) {
      return regex.test(req.headers.origin);
    })) {
      res.header('Access-Control-Allow-Origin', req.headers.origin);
      res.header('Access-Control-Allow-Methods', 'GET,POST');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
    }
  }
  next();
}

app.listen(process.env.PORT || port).on('error', function (err) {
  if (err) {
    console.error('Error while trying to launch the server: “' + err + '”.');
  }
});

console.log(
  meta.name +
  ' version ' + meta.version +
  ' running on ' + process.platform +
  ' and listening on port ' + port +
  '. The server time is ' + new Date().toLocaleTimeString() + '.'
);
