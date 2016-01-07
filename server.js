'use strict'

var domain = require('domain').create();
var os = require('os');
var moment = require('moment');
var config = require('config');
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

  var hosts = null;
  var availabilities = [];
  var check_counter = 0;

  var get_hosts = function(callback) {
    // Grab hostname of our self!
    var hostname = os.hostname();

    // Get all hosts we should check availability on, but now our self. This is to ring check all servers.
    // TODO: Change check strategy so all peers does not check all peers. This will cause alot of traffic when we scale.

    if (debug) {
      console.log(moment(new Date()).format("YYYY-MM-DD HH:mm:ss"), 'Loading asterisk hosts from', asterisk_config.get('iaxtable'), 'to check availability on');
    }

    knex
    .select('id', 'name','hostname', 'ari_user','ari_password')
    .from(asterisk_config.get('iaxtable'))
    .whereNot('name', hostname)
    .asCallback(function(err, rows) {
      if (err) throw err;
      hosts = rows;
    });
  };

  var update_availability = function(server_id, available) {
    // Check if local hash map knows about this host
    if (!availabilities[server_id]) {
      availabilities[server_id] = null;
    }

    // Availability changed, or run counter was divideable with 4. Lets update
    if (availabilities[server_id] != available || check_counter % 4 == 0) {

      var serverobj = {};
      serverobj.available = available;
      serverobj.available_last_check = moment(new Date()).format("YYYY-MM-DD HH:mm:ss");

      if (available == 1) {
        serverobj.available_last_seen = serverobj.available_last_check
      }

      knex.transaction(function(trx) {
        knex
        .where('id', '=', server_id)
        .update(serverobj)
        .into(asterisk_config.get('iaxtable'))
        .then(trx.commit)
        .catch(trx.rollback);
      })
      .then(function(resp) {
        if (debug) {
          console.log(moment(new Date()).format("YYYY-MM-DD HH:mm:ss"), 'Node ID:', server_id, '-', 'available:', available);
        }

        availabilities[server_id] = available;
      });
    }
  };

  // Check hosts for their availability
  var check_hosts = function() {
    if (lock == 1) return;

    lock = 1;
    if (hosts != null && hosts.length > 0)
    {
      hosts.forEach(function (row) {

        var request = https
        .get('https://' + row.hostname + ':18089/httpstatus', function(res) {
          if (res.statusCode == 200) {
            update_availability(row.id, 1);
          }
          else {
            update_availability(row.id, 0);
          }
        })
        .on('error', function(e) {
          update_availability(row.id, 0);
        });

        request.setTimeout( 500, function( ) {
          update_availability(row.id, 0);
        });

      });
    }
    else {
        get_hosts();
    }

    // Check table for new hosts
    if (check_counter == 20) {
      get_hosts();
      check_counter = 0;
    }

    check_counter++;
    lock = 0;
  };

  if (debug) {
    console.log(moment(new Date()).format("YYYY-MM-DD HH:mm:ss"), 'Will check availability of asterisk nodes every', config.get('update_interval_sec'), 'seconds');
  }

  // Lets update on first run!
  check_hosts();

  // Start timer
  var lock = 0;
   var update_timer = setInterval(function() {
     check_hosts();
   },
   (config.get('update_interval_sec') * 1000)
   );
});
