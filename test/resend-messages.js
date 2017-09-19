import test from 'ava';

import RabQ from '../.';
import resendMessages from '../lib/resend-messages';

import minimalOptions from './config.json';

test('republish content and remove it from store', async t => {
  const p = new RabQ(minimalOptions);

  p.messagesToSend.unicornId = {
    exchange: minimalOptions.exchange,
    routingKey: 'fake',
    content: {cat: 'Simon'}
  };

  t.truthy(p.messagesToSend.unicornId);
  await t.notThrows(resendMessages(null, null, p));
  t.falsy(p.messagesToSend.unicornId);
});
