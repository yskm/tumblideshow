var express = require('express');
var app = express();
var server = require('http').Server(app);
var hostname = process.env.HOSTNAME || 'localhost';
var port     = process.env.PORT     || '3000';
var io = require('socket.io')(server);

var session = require('express-session');
var session_secret = process.env.EXPRESS_SESSION_SECRET;
var RedisStore = require('connect-redis')(session);
var url = require('url');
var redisURL = url.parse(process.env.REDISCLOUD_URL || 'redis://localhost:6379');
var sessionStore = new RedisStore({
  host: redisURL.hostname,
  port: redisURL.port,
  pass: redisURL.auth? redisURL.auth.split(":")[1]: ''
});

var tumblr = require('tumblr.js');
var tumblr_consumer_key = process.env.TUMBLR_CONSUMER_KEY;
var tumblr_consumer_secret = process.env.TUMBLR_CONSUMER_SECRET;

var callback_url = 'http://'+hostname;
if (port !== '80') {
  callback_url += ':'+port;
}
callback_url += '/callback';

var OAuth = require('oauth').OAuth;
var oa = new OAuth(
  'http://www.tumblr.com/oauth/request_token',
  'http://www.tumblr.com/oauth/access_token',
  tumblr_consumer_key,
  tumblr_consumer_secret,
  '1.0',
  callback_url,
  'HMAC-SHA1'
);

io.use(function(socket, next) {
  var hashedCookies = require('cookie').parse(socket.request.headers.cookie);
  var cookies = require('cookie-parser/lib/parse').signedCookies(hashedCookies, session_secret);
  var sid = cookies['connect.sid'];

  sessionStore.get(sid, function(err, session) {
    if (err) {
      console.log(err);
      return;
    }

    socket.session = session;
    next();
  });
});

io.on('connection', function(socket) {
  console.log('socket.io connected: ' + socket.id);

  socket.on('start_loading', function(latest_post_id) {
    if (socket.session === undefined || socket.session.oauth_status !== 'authenticated') {
      return;
    }
    var client = tumblr.createClient({
      consumer_key: tumblr_consumer_key,
      consumer_secret: tumblr_consumer_secret,
      token: socket.session.oauth_access_token,
      token_secret: socket.session.oauth_access_token_secret
    });

    var interval =  setInterval(function() {
      if (latest_post_id) {
        client.dashboard({
            since_id: latest_post_id
        }, function(err, data) {
          if (err) {
            console.log(err);
            return;
          }

          if (data.posts !== undefined && data.posts.length > 0) {
            socket.emit('new_post', data);
            latest_post_id = data.posts[0].id;
          }
        });
      }
    }, 5000);

    socket.on('disconnect', function() {
      console.log('socket.io disconnected: ' + socket.id);
      clearInterval(interval);
    });
  });

});

app.use(session({
  secret: session_secret,
  store: sessionStore,
  resave: false,
  saveUninitialized: false
}));

app.use(express.static(__dirname + '/public'));

app.set('view engine', 'jade');

app.get('/', function(req, res) {
  if (req.session.oauth_status !== 'authenticated') {
    res.redirect('/auth');
    return;
  }
  res.render('index');
});

app.get('/posts', function(req, res) {
  if (req.session.oauth_status !== 'authenticated') {
    res.end();
    return;
  }
  else if (!'offset' in req.query) {
    res.end();
    return;
  }

  var client = tumblr.createClient({
    consumer_key: tumblr_consumer_key,
    consumer_secret: tumblr_consumer_secret,
    token: req.session.oauth_access_token,
    token_secret: req.session.oauth_access_token_secret
  });

  client.dashboard({
    offset: req.query.offset
  }, function(err, data) {
    if (err) {
      console.log(err);
      res.end();
      return;
    }

    res.contentType('application/json');
    res.send(JSON.stringify(data));
  });
});

app.get('/auth', function(req, res) {
  if (req.session.oauth_status === 'authenticated') {
    res.redirect('/');
  }
  else {
    oa.getOAuthRequestToken(function(err, oauth_token, oauth_token_secret, results) {
      if (err) {
        console.log(err);
        res.end();
        return;
      }

      req.session.oauth_token = oauth_token;
      req.session.oauth_token_secret = oauth_token_secret;
      req.session.oauth_status = 'initialized';
      res.redirect('http://www.tumblr.com/oauth/authorize?oauth_token='+oauth_token);
    });
  }
});

app.get('/callback', function(req, res) {
  if (req.session.oauth_status === 'initialized') {
    oa.getOAuthAccessToken(
      req.session.oauth_token,
      req.session.oauth_token_secret,
      req.query.oauth_verifier,
      function(err, oauth_access_token, oauth_access_token_secret, results) {
        if (err) {
          console.log(err);
          res.end();
          return;
        }

        req.session.oauth_access_token = oauth_access_token;
        req.session.oauth_access_token_secret = oauth_access_token_secret;
        req.session.oauth_status = 'authenticated';
        res.redirect('/');
      }
    );
  }
  else {
    res.redirect('/');
  }
});

server.listen(parseInt(port), function() {
  console.log('listening on '+hostname+':'+port);
});
