'use strict';

const uuid = require('uuid');

module.exports = (conn, ch, rabQ) => {
  ch.prefetch(rabQ.maxMessages);

  return Promise.all(rabQ.queues.map(queue => {
    // Consume each message and apply function
    return ch.consume(queue, msg => {
      try {
        const parsedMsg = {
          content: JSON.parse(msg.content.toString()),
          rk: msg.fields.routingKey,
          queue,
          token: getTokenFromMessage(msg),
          originMsg: msg,
          consumeAt: Date.now(),
          ACK: 'ACK',
          NACK: 'NACK',
          REJECT: 'REJECT'
        };

        if (rabQ.autoAck) {
          ch.ack(parsedMsg.originMsg);
        }

        execAction(parsedMsg, rabQ, ch);
      } catch (e) {
        if (e instanceof SyntaxError) { // JSON parse error
          rabQ.emit('log', {
            level: 'error',
            uuid: null,
            token: getTokenFromMessage(msg),
            msg: `Unable to parse incoming message ${msg.content.toString()}`
          });
        } else {
          rabQ.emit('log', {
            level: 'error',
            uuid: null,
            token: getTokenFromMessage(msg),
            msg: `Error while processing message` + e,
            err: e
          });
        }

        const isRequeue = false;
        ch.nack(msg, false, isRequeue);
      }
    });
  }))
    .then(() => ([conn, ch]));
};

function getTokenFromMessage(msg) {
  if (msg && msg.properties && msg.properties.headers) {
    return msg.properties.headers['x-query-token'] || msg.properties.headers['X-QUERY-TOKEN'] || uuid.v4();
  }

  return uuid.v4();
}

function execAction(parsedMsg, rabQ, ch) {
  // TODO why attach rabQ on message
  parsedMsg.rabQ = rabQ;

  const unackedMessageId = uuid.v4();
  rabQ.unackedMessages[unackedMessageId] = parsedMsg;

  const msgSubscribers = rabQ.subscribers.filter(subscriber => subscriber.patternMatch.test(parsedMsg.rk));

  rabQ.emit('log', {
    level: 'info',
    uuid: parsedMsg.content.uuid,
    token: parsedMsg.token,
    msg: `${msgSubscribers.length} subscribers for this message (${parsedMsg.rk})`
  });

  const runActionsPromises = msgSubscribers.map(actions => {
    actions.before = actions.before || (() => Promise.resolve());
    actions.after = actions.after || ((message, returnCode) => Promise.resolve(returnCode));
    return actions.before(parsedMsg)
      .then(() => actions.do(parsedMsg))
      .then(returnCode => actions.after(parsedMsg, returnCode));
  });

  Promise.all(runActionsPromises)
    .then(results => {
      // If autoAck mode, so nothing to do
      if (rabQ.autoAck) {
        rabQ.emit('log', {
          level: 'info',
          uuid: parsedMsg.content.uuid,
          token: parsedMsg.token,
          msg: `rabQ autoAck mode`
        });
        return;
      }

      if (results.length === 0) {
        rabQ.emit('log', {
          level: 'error',
          uuid: parsedMsg.content.uuid,
          token: parsedMsg.token,
          msg: `No ack, nack or reject. No one seems to treat the message`
        });
        const isRequeue = false;
        return ch.nack(parsedMsg.originMsg, false, isRequeue);
      }

      if (results.length > 1) {
        rabQ.emit('log', {
          level: 'error',
          uuid: parsedMsg.content.uuid,
          token: parsedMsg.token,
          msg: `Many subscribers listen same message. Use autoAck or merge your subscribers. Results = ${results}`
        });
        const isRequeue = false;
        return ch.nack(parsedMsg.originMsg, false, isRequeue);
      }

      const subscriberResult = results[0];
      const processTime = (Date.now() - parsedMsg.consumeAt);

      switch (subscriberResult) {
        case parsedMsg.ACK:
          rabQ.emit('log', {
            level: 'info',
            uuid: parsedMsg.content.uuid,
            token: parsedMsg.token,
            msg: `Message processed (and ack) in ${processTime} ms`
          });
          ch.ack(parsedMsg.originMsg);
          break;
        case parsedMsg.NACK:
          if (parsedMsg.originMsg.fields.redelivered) {
            rabQ.emit('log', {
              level: 'info',
              uuid: parsedMsg.content.uuid,
              token: parsedMsg.token,
              msg: `Message processed (and reject) in ${processTime} ms`
            });
            const isRequeue = false;
            ch.nack(parsedMsg.originMsg, false, isRequeue);
          } else {
            setTimeout(() => {
              rabQ.emit('log', {
                level: 'info',
                uuid: parsedMsg.content.uuid,
                token: parsedMsg.token,
                msg: `Message processed (and nack) in ${processTime} ms`
              });
              ch.nack(parsedMsg.originMsg);
            }, rabQ.nackDelay);
          }
          break;
        case parsedMsg.REJECT: {
          rabQ.emit('log', {
            level: 'info',
            uuid: parsedMsg.content.uuid,
            token: parsedMsg.token,
            msg: `Message processed (and reject) in ${processTime} ms`
          });
          const isRequeue = false;
          ch.nack(parsedMsg.originMsg, false, isRequeue);
          break;
        }
        default: {
          rabQ.emit('log', {
            level: 'warn',
            uuid: parsedMsg.content.uuid,
            token: parsedMsg.token,
            msg: `Consumer doesn't return a promise resolved with value ACK|NACK|REJECT (${subscriberResult}). Message will be reject`
          });
          rabQ.emit('log', {
            level: 'info',
            uuid: parsedMsg.content.uuid,
            token: parsedMsg.token,
            msg: `Message processed (and reject) in ${processTime} ms`
          });
          const isRequeue = false;
          ch.nack(parsedMsg.originMsg, false, isRequeue);
        }
      }

      delete rabQ.unackedMessages[unackedMessageId];
    })
    .catch(err => {
      rabQ.emit('log', {
        level: 'error',
        uuid: parsedMsg.content.uuid,
        token: parsedMsg.token,
        msg: `Error while treating message`,
        err
      });
      const isRequeue = false;
      return ch.nack(parsedMsg.originMsg, false, isRequeue);
    });
}