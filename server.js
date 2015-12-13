'use strict'

var domain = require('domain').create();
var os = require('os');
var moment = require('moment');
var config = require('config');
var mysql_config = config.get('mysql');
var asterisk_config = config.get('asterisk');
var client = require('ari-client');
var exec = require('child_process').exec;
var util = require('util');
var debug = process.env.NODE_DEBUG || config.get('debug') || true;
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
    if (debug)
      console.log(moment(new Date()).format("YYYY-MM-DD HH:mm:ss"), err);
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
    // TODO: Put in knex transaction on this!

    console.log(moment(new Date()).format("YYYY-MM-DD HH:mm:ss"), 'Loading asterisk hosts from', asterisk_config.get('iaxtable'), 'to check availability on');
    knex
    .select('id', 'name','ipaddr', 'manager_user','manager_password', 'local_ip')
    .from(asterisk_config.get('iaxtable'))
    .whereNot('name', hostname)
    .asCallback(function(err, rows) {
      if (err) throw err;
      hosts = rows;
    });
  };

  // Check hosts for their availability
  var check_hosts = function() {
    if (lock == 1) return;

    lock = 1;
    if (hosts != null && hosts.length > 0)
    {
      hosts.forEach(function (row) {

        var available = 0;
        // console.log ('Checking host', row.name);
        // client.connect('https://sip04-voip-aws-eu.publicdns.zone:8089', row.manager_user, 'oPNl8mGtWNBcWS6l',
        // function (err, ari) {
        //   if (err) throw err;
        //   console.log(ari);
        //
        //   ari.asterisk.getInfo(function (err, asteriskinfo) {
        //       if (err) throw err;
        //       console.log(asteriskinfo)
        //     }
        //   );
        //
        //   console.log('Done checking');
        // });

        //exec('/usr/local/bin/check_asterisk -U sip:100@' + row.local_ip + ' -w 100 -c 200',
        exec('/sbin/ping -c 1 ' + row.ipaddr,
          function (err, stdout, stderr) {
            if (err)  throw err;

            //console.log('err: ' + err);
            //console.log('stdout: ' + stdout);
            //console.log('stderr: ' + stderr);

            if (stdout)
            {
              // Check if we got a sip OK back
              if (stdout.indexOf('0.0% packet loss') > -1) {
                available = 1;
              }

              // Check if local hash map knows about this host
              if (!availabilities[row.name]) {
                availabilities[row.name] = null;
              }

              // Availability changed, or run counter was divideable with 4. Lets update
              if (availabilities[row.name] != available || check_counter % 4 == 0)
              {

                var serverobj = {};
                serverobj.available = available;
                serverobj.available_last_check = moment(new Date()).format("YYYY-MM-DD HH:mm:ss");
                if (available == 1) {
                  serverobj.available_last_seen = moment(new Date()).format("YYYY-MM-DD HH:mm:ss");
                }

                knex
                  .where('id', '=', row.id)
                  .update(serverobj)
                  .into(asterisk_config.get('iaxtable'))
                  .asCallback(function(err, rows) {
                    if (err) throw err;
                    if (debug)
                      console.log(moment(new Date()).format("YYYY-MM-DD HH:mm:ss"), 'Node:', row.name, '-', 'local ip:', row.local_ip, '-','public ip:', row.ipaddr, '-', 'available:', available);

                      availabilities[row.name] = available;
                  });
              }
            }
        });

      });
    }
    else {
      if (check_counter == 0) {
        get_hosts();
      }
    }

    // Check table for new hosts
    if (check_counter == 20) {
      get_hosts();
      check_counter = 0;
    }

    check_counter++;
    lock = 0;
  };

  if (debug)
    console.log(moment(new Date()).format("YYYY-MM-DD HH:mm:ss"), 'Will check availability of asterisk nodes every', config.get('update_interval_sec'), 'seconds');

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
