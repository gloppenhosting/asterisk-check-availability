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
var AMI = require('./ami');

var knex = require('knex')({
    client: 'mysql2',
    connection: {
        host: (process.env.MYSQL_HOST || mysql_config.get('host') || '127.0.0.1'),
        user: (process.env.MYSQL_USER || mysql_config.get('user') || 'root'),
        password: (process.env.MYSQL_PASSWORD || mysql_config.get('password') || ''),
        database: (process.env.MYSQL_DB || mysql_config.get('database') || 'asterisk')
    },
    pool: {
        ping: function(connection, callback) {
            connection.query({
                sql: 'SELECT 1 = 1'
            }, [], callback);
        },
        min: 1,
        max: 2
    }
});

// On any errors. Write them to console and exit program with error code
domain.on('error', function(err) {
    if (debug) {
        console.log(moment(new Date()).format("YYYY-MM-DD HH:mm:ss"), err);
    }

    process.exit(1);
});

// Encapsulate it all into a domain to catch all errors
domain.run(function() {
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
                        console.log(moment(new Date()).format("YYYY-MM-DD HH:mm:ss"), 'Node Name:', server_id, '-', 'available:', available);
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
        } else {
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
                } else {
                    update_availability(hostname, 0);
                }
            })
            .on('error', function(e) {
                update_availability(hostname, 0);
            });

        // Fail if the https makes a timeout
        request.setTimeout(600, function() {
            update_availability(hostname, 0);
        });
    };

    var check_send_registration = function() {
        var hostname = os.hostname();

        knex
            .select('send_registrations.id', 'send_registrations.ps_registrations_id','iaxfriends.manager_user','iaxfriends.manager_password','iaxfriends.local_ip')
            .from('send_registrations')
            .innerJoin('iaxfriends', 'send_registrations.iaxfriends_id', 'iaxfriends.id')
            .where('iaxfriends.name', hostname)
            .orderBy('send_registrations.created', 'asc')
            .limit(1)
            .then(function(rows) {
                rows.forEach(function (row) {
                    // Send register to Asterisk

                    var ami = new AMI({
                        port: 15039,
                        host: row.local_ip,
                        username: row.manager_user,
                        password: row.manager_password
                    });

                    ami.connect(function () {
                        ami.send({
                            Action: 'Command',
                            Command: 'pjsip send register ' + row.ps_registrations_id
                        }, function () {
                            ami.disconnect();

                            knex.transaction(function(trx) {
                                trx('send_registrations')
                                .where('id', row.id)
                                .delete()
                                .then(trx.commit)
                                .catch(trx.rollback);
                            })
                            .then(function(resp) {
                                if (debug) {
                                    console.log(moment(new Date()).format("YYYY-MM-DD HH:mm:ss"), 'Registration send and released for', row.ps_registrations_id);
                                }
                            });

                        });
                    });
                });

            })
            .catch(function(err) {
                if (debug) {
                    console.log(moment(new Date()).format("YYYY-MM-DD HH:mm:ss"), 'Unable to get');
                }
            });
    }

    if (debug) {
        console.log(moment(new Date()).format("YYYY-MM-DD HH:mm:ss"), 'Will check availability of the asterisk node every', config.get('update_interval_sec'), 'seconds');
    }

    // Lets update on first run!
    check_host();
    check_send_registration();

    // Start timer for availaibility check
    var update_timer = setInterval(function() {
        check_host();
    },
    (config.get('update_interval_sec') * 1000));

    // Start timer for send_registrations
    var registration_timer = setInterval(function() {
        check_send_registration();
    },
    (config.get('update_interval_sec') * 1000));
});
