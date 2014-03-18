what the #*@$#% is this?
==========

BrODB

http://www.urbandictionary.com/define.php?term=brodb

to run it as a server:

    node brodb.js

Test using redis-cli:

    $ redis-cli -p 2666
    redis 127.0.0.1:2666> txn start
    OK
    redis 127.0.0.1:2666> cs start
    (error) error, bad cursor command
    redis 127.0.0.1:2666> cs open
    OK
    redis 127.0.0.1:2666> cs first
    OK
    redis 127.0.0.1:2666> cs getAll
    1) "111"
    2) "123"
    3) "12343"
    4) "388"
    5) "3"
    6) "8s"
    7) "8"
    redis 127.0.0.1:2666> cs close
    OK
    redis 127.0.0.1:2666> txn commit
    OK
    redis 127.0.0.1:2666> set aaa 777
    OK
    redis 127.0.0.1:2666> get aaa
    "777"
    redis 127.0.0.1:2666> del aaa
    OK deleted
    redis 127.0.0.1:2666> get aaa
    (error) not found
    redis 127.0.0.1:2666> 

for more info read brodb.js
