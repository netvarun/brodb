var mkdirp = require('mkdirp');
var rp = require('redis-protocol');
var lmdb = require('node-lmdb');
var argv = require('minimist')(process.argv.slice(2));
var EventEmitter = require('events').EventEmitter;
var util = require('util');

// use the wonderful lmdb 

function lmdbCmd(dbi, env, encoder, cmd, args) {
    var txn;
    // strategy is to use 'string' for everything.
    // that way JSON.stringify in/out of value for key
    // and then use jsonpath or js to search & process
    switch(cmd){
        case 'set':
            txn = env.beginTxn();
            txn.putString(dbi, args[0], args[1]);
            txn.commit();
            encoder.singleline('OK');
            break;
        case 'get':
            txn = env.beginTxn({readOnly: true});
            var data = txn.getString(dbi,args[0]);
            txn.commit();
            if (data)
                encoder.encode(data);
            else
                encoder.error('not found');
            break;
        case 'del':
            txn = env.beginTxn();
            txn.del(dbi, args[0]);
            txn.commit();
            encoder.singleline('OK deleted');
            break;
        default:
            encoder.error("error, bad command");
    }
}

var BroDB = function(conf) {
    var env = new lmdb.Env();
    var encoder;
    var self = this;

    mkdirp(conf.path, function(err) {
        if (!!err)
            console.log(err);
    });
    env.open(conf);
    var dbi = env.openDbi(conf);
    self.txn = null;
    self.cursor = null;
    var key;

    // provide a 'pseudo' redis protocol, it will
    // support some redis commands and clients

    self.server = rp.createServer(function(command) {
        if (!command) {
            self.emit('error','null command');
            return;
        }
        //console.log('>>>', command);
        encoder = this;
        switch(command[0]) {
            case 'quit':
                encoder.singleline('OK bye');
                dbi.close();
                env.close();
                self.emit('quit', 'user requested quit');
                break;
            case 'info':
                encoder.encode(JSON.stringify(conf));
                break;
            case 'txn':         // custom command
            case 'transaction':
                switch(command[1]) {
                    case 'begin':
                    case 'start':
                        self.txn = env.beginTxn();
                        encoder.singleline('OK');
                        break;
                    case 'commit':
                        self.txn.commit();
                        self.txn = null;
                        encoder.singleline('OK');
                        break;
                    case 'abort':
                        self.txn.abort();
                        self.txn = null;
                        encoder.singleline('OK');
                        break;
                    default:
                        self.emit('error','bad transaction command', command[1]);
                        encoder.error('error, bad transaction command');
                }
                break;
            case 'cs':          // custom command
            case 'cursor':      // for iterating the always ordered keys
                if (!self.txn) {
                    self.emit('error', 'cursor open when txn is null');
                    encoder.error('error, no active transaction');
                    return;
                }
                switch(command[1]) {
                    case 'open':
                    case 'init':
                        self.cursor = new lmdb.Cursor(self.txn, dbi);
                        if (!self.cursor) {
                            self.emit('error','cannot get a cursor');
                            encoder.error('error, cannot get a cursor');
                            return;
                        }
                        encoder.singleline('OK');
                        break;
                    case 'close':
                    case 'delete':
                        self.cursor.close();
                        self.cursor = null;
                        encoder.singleline('OK');
                        break;
                    case 'first':
                        key = self.cursor.goToFirst();
                        if (key) {
                            encoder.singleline('OK');
                        } else {
                            encoder.error('error, cannot go to first');
                        }
                        break;
                    case 'next':
                        key = self.cursor.goToNext();
                        if (key) {
                            encoder.singleline('OK');
                        } else {
                            encoder.error('error, cannot go to next');
                        }
                        break;
                    case 'prev':
                        key = self.cursor.goToPrev();
                        if (key) {
                            encoder.singleline('OK');
                        } else {
                            encoder.error('error, cannot go to prev');
                        }
                        break;
                    case 'gorange':
                        if (!command[2]) {
                            encoder.error('error, range arg required');
                        } else {
                            key = self.cursor.goToRange(command[2]);
                            if (key) {
                                encoder.singleline('OK');
                            } else {
                                encoder.error('error, cannot go to range');
                            }
                        }
                        break;
                    case 'gokey':
                        if (!command[2]) {
                            encoder.error('error, key arg required');
                        } else {
                            key = self.cursor.goToKey(command[2]);
                            if (key) {
                                encoder.singleline('OK');
                            } else {
                                encoder.error('error, cannot go to that key');
                            }
                        }
                        break;
                    case 'getkey':
                        encoder.encode(key = self.cursor.getCurrentString());
                        break;
                    // so the lmdb keys are always ordered in btree on disk
                    // making it easy to iterate like arrays. a good data
                    // set may be array of json data
                    case 'getAll':
                        var result = [];
                        for (var key = self.cursor.getCurrentString(); key; key = self.cursor.goToNext()) {
                            result.push(self.txn.getString(dbi,key));
                        }
                        encoder.encode(result);
                        break;
                    default:
                        self.emit('error','bad cursor command', command[1]);
                        encoder.error('error, bad cursor command');
                        break;
                }
                break;
            default:
                lmdbCmd(dbi, env, encoder, command[0],command.slice(1));
        }
    });

    self.server.listen(conf.port, function() {
        console.log('brodb started at port',conf.port);
    });
};

util.inherits(BroDB, EventEmitter);

BroDB.prototype.close = function() {
    var self = this;
    self.server.close();
};

if (require.main == module) {
    // you can have multiple named dbs inside a db, like 'db1', 'db2',...
    var db1 = new BroDB({
        name: 'db1',
        path: !!argv.d ? argv.d : './dbdir',
        port: !!argv.p ? argv.p : 2666,
        maxDbs: !!argv.n ? argv.n : 10,
        mapSize: !!argv.s ? argv.s : 16 * 1024 * 1024,
        dupSort: true
    });

    // and you can have multiple instances of brodb in different
    // directories './dbdir1', './dbdir2', ...
    // since all data is transactionally written to the disk via mmap
    // and data length per key can be large (unlike leveldb and redis)
    // without slowing down, it is possible to store a lot of data,
    // much more than available RAM, and cluster these things together.

    db1.on('quit', function(err) {
        db1.close();
        console.log(err);
    });
    db1.on('error', function(err) {
        console.log(err);
    });
}

module.exports = BroDB;
