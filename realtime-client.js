(function (global) {
  'use strict';

  // Experimental Amvera transport. Nothing connects until the explicit
  // realtime_api=1 test flag is present in the Telegram Mini App URL.
  function createRussianRealtimeClient(baseUrl, code, initData, onEvent, onReconnect) {
    var connection = { state: 'initialized', connect: connect };
    var closed = false;
    var token = '';
    var controller = null;
    var connecting = null;
    var retryTimer = null;
    var connectedBefore = false;

    async function request(path, body, bearer) {
      var timeout = new AbortController();
      var timer = setTimeout(function () { timeout.abort(); }, 12000);
      try {
        var response = await fetch(baseUrl + '/api/game/realtime/' + path, {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, bearer ? { Authorization: 'Bearer ' + bearer } : {}),
          body: JSON.stringify(body), signal: timeout.signal
        });
        if (!response.ok) throw new Error('Realtime API ' + response.status);
        return response.json();
      } finally { clearTimeout(timer); }
    }

    function scheduleReconnect() {
      if (closed || retryTimer) return;
      retryTimer = setTimeout(function () {
        retryTimer = null;
        connect().catch(function () { scheduleReconnect(); });
      }, 1500);
    }

    function connect() {
      if (closed) return Promise.reject(new Error('Realtime client closed'));
      if (connection.state === 'connected') return Promise.resolve();
      if (connecting) return connecting;
      connection.state = 'connecting';
      connecting = (async function () {
        var joined = await request('join', { code: code, initData: initData });
        if (closed) return;
        token = joined.token;
        controller = new AbortController();
        var streamTimeout = setTimeout(function () { controller.abort(); }, 12000);
        var response;
        try { response = await fetch(baseUrl + '/api/game/realtime/stream', {
          headers: { Authorization: 'Bearer ' + token },
          signal: controller.signal,
          cache: 'no-store'
        }); } catch (error) { clearTimeout(streamTimeout); throw error; }
        if (!response.ok || !response.body) throw new Error('Realtime stream ' + response.status);
        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';
        function consume(chunk) {
          buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
          var boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            var frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (frame.indexOf('data: ') !== 0) continue;
            try {
              var message = JSON.parse(frame.slice(6));
              onEvent(message.name, message.data);
            } catch (error) { console.warn('Realtime event ignored', error); }
          }
        }
        var first = await reader.read();
        clearTimeout(streamTimeout);
        if (first.done) throw new Error('Realtime stream closed');
        consume(first.value);
        if (closed) return;
        connection.state = 'connected';
        if (connectedBefore && onReconnect) onReconnect();
        connectedBefore = true;
        (async function () {
          try {
            while (!closed) {
              var item = await reader.read();
              if (item.done) break;
              consume(item.value);
            }
          } catch (error) {
            if (!closed) console.warn('Realtime stream disconnected', error);
          } finally {
            if (!closed) {
              connection.state = 'disconnected';
              token = '';
              scheduleReconnect();
            }
          }
        })();
      })().finally(function () { connecting = null; });
      return connecting.catch(function (error) {
        if (!closed) connection.state = 'failed';
        throw error;
      });
    }

    function publish(name, data) {
      if (connection.state !== 'connected') return Promise.reject(new Error('Realtime not connected'));
      return request('publish', { name: name, data: data }, token);
    }

    function close() {
      closed = true;
      connection.state = 'closed';
      token = '';
      if (retryTimer) clearTimeout(retryTimer);
      if (controller) controller.abort();
    }

    return { connection: connection, connect: connect, publish: publish, close: close };
  }

  global.createRussianRealtimeClient = createRussianRealtimeClient;
})(window);
