// Serving the setup prompt on the LAN instead of carrying it across by copy-paste.
//
// The harness's own web server binds 127.0.0.1 (measured on a real controller), so the other machine cannot
// reach it and this feature has to start its own listener. That puts the prompt on the local network, so the
// checks below are about the three things that bound the exposure: the short path segment, the closing time,
// and the one machine allowed to read it.
import { DEFAULT_SHARE_MINUTES, MAX_SHARE_MINUTES, MIN_SHARE_MINUTES, PromptShare, localAddresses, shortToken } from '../lib/share.js';

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`);
};

const PROMPT = `目标：把本机配成一台可被远程派活的 DSH 被控机。\n${'正文一行。'.repeat(40)}`;

console.log('the path segment is short enough to type:');
{
  const samples = Array.from({ length: 200 }, () => shortToken());
  check('four lowercase letters', samples.every((token) => /^[a-z]{4}$/.test(token)), samples.slice(0, 5).join(' '));
  check('no uppercase to mistype', samples.every((token) => token === token.toLowerCase()));
  check('no digits or punctuation', samples.every((token) => /^[a-z]+$/.test(token)));
  // Bias check: `randomBytes % 26` would over-produce the first letters. Every letter should appear.
  const seen = new Set(samples.join(''));
  check('the alphabet is not biased away from late letters', seen.size >= 20, `${String(seen.size)} distinct letters`);
  check('repeated calls do not repeat themselves', new Set(samples).size > 190, `${String(new Set(samples).size)} of 200 distinct`);
}

console.log('\nthe address that gets advertised:');
{
  // Written against whatever this machine actually has, because the ranking is a property of the ALGORITHM, not
  // of one network. An earlier version asserted a literal address, which made the suite pass only on the machine
  // it was written on.
  const all = localAddresses({ preferAddress: '192.168.1.10' });
  check('at least one address is offered', all.length > 0, all.join(', '));
  check('no loopback address is ever offered', all.every((address) => !address.startsWith('127.')), all.join(', '));

  // The address that shares a prefix with the target must beat every address that does not — and only that claim
  // is checkable without knowing this host's network.
  const prefix = '192.168.1.';
  const sharing = all.filter((address) => address.startsWith(prefix));
  check('an address sharing the target prefix wins', sharing.length === 0 || all[0].startsWith(prefix), `got ${all[0]} from ${all.join(', ')}`);

  const tunnel = all.filter((address) => !address.startsWith(prefix) && /^(10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address));
  check('a VPN address is not preferred over a LAN address', sharing.length === 0 || tunnel.every((address) => all.indexOf(address) > 0), all.join(', '));
  check('with no hint an address is still offered', localAddresses({}).length > 0, localAddresses({}).join(', '));
}

console.log('\npublishing and fetching:');
const share = new PromptShare();
{
  const published = await share.publish({ prompt: PROMPT, preferAddress: '192.168.1.10', minutes: 3 });
  check('the address is ip:port/letters and nothing more', /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/[a-z]{4}$/.test(published.url), published.url);
  check('it uses the interface it bound', published.url.includes(published.boundAddress), `${published.url} vs ${published.boundAddress}`);
  check('the port is an ephemeral one', Number(new URL(published.url).port) > 1024, new URL(published.url).port);
  check('it reports the window in minutes', published.minutes === 3, String(published.minutes));
  check('and when it closes', published.closesAt > Date.now(), String(published.closesAt));
  check('the share reports itself active', share.active === true);
  check('a self-closing timer is armed', share.closeTimer !== undefined);
}

console.log('\nonly the named machine may read it:');
{
  const published = await share.publish({ prompt: PROMPT, preferAddress: '192.168.1.10' });
  check('the reader is recorded', published.reader === '192.168.1.10', String(published.reader));
  // This test host is loopback, not the controlled machine, so it must be refused. That is the point: with a
  // four-letter segment, pinning the reader is what actually keeps a neighbour out.
  const refused = await fetch(published.url);
  check('another host is refused', refused.status === 403, String(refused.status));
  check('and is told whose prompt it is', (await refused.text()).includes('192.168.1.10'), 'the reason must name the reader');
  const alone = await share.publish({ prompt: PROMPT });
  check('with no reader named, anybody on the network is served', (await fetch(alone.url)).status === 200, 'the caller chose this by omitting the host');
}

console.log('\nthe prompt is served verbatim:');
{
  const published = await share.publish({ prompt: PROMPT });
  const answer = await fetch(published.url);
  check('the fetch succeeds', answer.status === 200, String(answer.status));
  check('the body is the prompt verbatim', (await answer.text()) === PROMPT);
  check('it is plain text so the machine can pipe it', String(answer.headers.get('content-type')).startsWith('text/plain'), String(answer.headers.get('content-type')));
  check('it must not be cached', answer.headers.get('cache-control') === 'no-store', String(answer.headers.get('cache-control')));
}

console.log('\npaths and methods:');
{
  const published = await share.publish({ prompt: PROMPT });
  const origin = new URL(published.url).origin;
  check('the bare root is not the prompt', (await fetch(`${origin}/`)).status === 404, 'the segment is required');
  const wrong = await fetch(`${origin}/zzzz`);
  check('a wrong segment is 404', wrong.status === 404, String(wrong.status));
  check('and looks exactly like an unknown path', (await fetch(`${origin}/nope/deeper`)).status === 404, 'probing must learn nothing');
  check('the right segment still works', (await fetch(published.url)).status === 200);
  const posted = await fetch(published.url, { method: 'POST' });
  check('a write method is refused', posted.status === 405, String(posted.status));
  const head = await fetch(published.url, { method: 'HEAD' });
  check('HEAD is answered', head.status === 200, String(head.status));
  check('HEAD carries no body', (await head.text()) === '');
}

console.log('\nthe closing time:');
{
  check('the default window is a few minutes', DEFAULT_SHARE_MINUTES === 5, String(DEFAULT_SHARE_MINUTES));
  const published = await share.publish({ prompt: PROMPT, minutes: 1 });
  check('a caller-supplied window is honoured', Math.round((published.closesAt - Date.now()) / 60_000) === 1, String(published.closesAt));
  const tooSmall = await share.publish({ prompt: PROMPT, minutes: 0 });
  check('a zero window is clamped up, not accepted', tooSmall.minutes === MIN_SHARE_MINUTES, String(tooSmall.minutes));
  const tooBig = await share.publish({ prompt: PROMPT, minutes: 9999 });
  check('an absurd window is clamped down', tooBig.minutes === MAX_SHARE_MINUTES, String(tooBig.minutes));
  const junk = await share.publish({ prompt: PROMPT, minutes: 'soon' });
  check('a nonsense window falls back to the default', junk.minutes === DEFAULT_SHARE_MINUTES, String(junk.minutes));
}

console.log('\nreplacing, closing, and restarting:');
{
  const first = await share.publish({ prompt: 'one' });
  const second = await share.publish({ prompt: 'two' });
  check('publishing again issues a new address', first.url !== second.url, 'each offer gets its own segment');
  check('the previous segment stops working', (await fetch(first.url)).status === 404, 'a replaced segment is indistinguishable from one that never existed');
  check('the new one works', (await fetch(second.url)).status === 200);

  await share.close();
  check('close reports the share inactive', share.active === false);
  check('the port is released', share.port === undefined, String(share.port));
  check('the countdown timer is cancelled', share.closeTimer === undefined, 'a stray timer would close a later offer');
  const again = await share.publish({ prompt: 'again' });
  check('publishing after close binds a new listener', again.url.startsWith('http://'), again.url);
  check('and it answers', (await fetch(again.url)).status === 200);
  const withdrawn = await share.withdraw();
  check('withdrawing reports that it did something', withdrawn === true);
  check('withdrawing again reports nothing to do', (await share.withdraw()) === false, 'nothing was live the second time');
  // Withdrawing closes the LISTENER, not just the offer: the countdown exists so that nothing stays
  // listening, and closing early has to mean the same thing. The address therefore refuses connections
  // rather than answering 404.
  const gone = await fetch(again.url).then(() => 'reached', (error) => String(error?.cause?.code ?? error?.code ?? error));
  check('the port stops accepting connections entirely', gone === 'ECONNREFUSED', gone);
  check('reaching it again needs a new publish', (await share.publish({ prompt: 'fresh' })).url.startsWith('http://'), 'a new listener on a new port');
  await share.close();
}

console.log('\nthe self-closing timer is real:');
{
  const timer = new PromptShare();
  // `#armClose` is private; the observable contract is that a published offer carries a live timer and that
  // replacing the offer does not leave the old timer to close the new one.
  await timer.publish({ prompt: 'a' });
  const firstTimer = timer.closeTimer;
  await timer.publish({ prompt: 'b' });
  check('re-arming replaces the previous timer', timer.closeTimer !== firstTimer, 'the first timer must not close the second offer');
  await timer.close();
  check('closing clears it', timer.closeTimer === undefined);
}

console.log(`\n${failures === 0 ? 'PROMPT SHARE VERIFIED' : `${String(failures)} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
