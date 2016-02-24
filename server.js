'use strict'

var domain = require('domain').create();
var os = require('os');
var moment = require('moment');
var config = require('config');
var ip = require("ip");
var mysql_config = config.get('mysql');
var asterisk_config = config.get('asterisk');
var debug = process.env.NODE_DEBUG || config.get('debug') || true;
var https = require('https');

var knex = require('knex')(
{
  client: 'mysql2',
  connection: {
    host     : (process.env.MYSQL_HOST || mysql_config.get('host') || '127.0.0.1'),
    user     : (process.env.MYSQL_USER || mysql_config.get('user') || 'root'),
    password : (process.env.MYSQL_PASSWORD || mysql_config.get('password') || ''),
    database : (process.env.MYSQL_DB || mysql_config.get('database') || 'asterisk')
  },
  pool: {
      
      min: 1,
      max: 2
  }
});

// On any errors. Write them to console and exit program with error code
domain.on('error', function (err) {
    if (debug) {
      console.log(moment(new Date()).format("YYYY-MM-DD HH:mm:ss"), err);
    }

    process.exit(1);
});

// Encapsulate it all into a domain to catch all errors
domain.run(function () {
  var check_counter = 0;
  var lock = 0; // mutex lock

  var update_availability = function(server_id, available) {
    check_counter++;

    // Availability changed, or run counter was divideable with 4. Lets update
    if (available == 1 || (check_counter % 30 == 0 && available == 0)) {

      knex.transaction(function(trx) {
        var serverobj = {};
        serverobj.available = 1;
        serverobj.available_last_check = moment(new Date()).format("YYYY-MM-DD HH:mm:ss");
        serverobj.available_last_seen = serverobj.available_last_check

        trx
        .where('name', '=', server_id)
        .update(serverobj)
        .into(asterisk_config.get('iaxtable'))
        .then(trx.commit)
        .catch(trx.rollback);
      })
      .then(function(resp) {
        if (debug) {
          console.log(moment(new Date()).format("YYYY-MM-DD HH:mm:ss"), 'Node Name:', server_id, '-', 'available: 1');
        }

        check_counter = 0;
        lock = 0;
      })
      .catch(function(err) {
        if (debug) {
          console.error(moment(new Date()).format("YYYY-MM-DD HH:mm:ss"), err);
        }

        lock = 0;
        throw new Error('Something bad happened to the transaction', err);
      });
    }
    else {
      // Release lock
      lock = 0;
    }
  };

  // Check hosts for their availability
  var check_host = function() {
    if (lock == 1) return;

    // Mutex lock
    lock = 1;

    // Alow to connect with HTTPS TLS to the path without the certs matching
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    var hostname = os.hostname();

    var request = https
    .get('https://' + ip.address() + ':18089/httpstatus', function(res) {
      if (res.statusCode == 200) {
        update_availability(hostname, 1);
      }
      else {
        update_availability(hostname, 0);
      }
    })
    .on('error', function(e) {
      update_availability(hostname, 0);
    });

    // Fail if the https makes a timeout
    request.setTimeout( 600, function( ) {
      update_availability(hostname, 0);
    });
  };

  if (debug) {
    console.log(moment(new Date()).format("YYYY-MM-DD HH:mm:ss"), 'Will check availability of the asterisk node every', config.get('update_interval_sec'), 'seconds');
  }

  // Lets update on first run!
  check_host();

  // Start timer
  var update_timer = setInterval(function() {
     check_host();
  },
  (config.get('update_interval_sec') * 1000));
});
