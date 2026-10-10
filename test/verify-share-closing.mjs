// The prompt listener's lifetime: a read must never end it.
//
// Reported from a real attempt: the controlled machine's fetch tool refuses private addresses, so the first
// attempt delivered nothing — but the request still reached the listener, which closed the port. The retry with
// a different tool found nothing listening. The prompt's lifetime had been keyed on the wrong event.
//
// This suite covers the listener's own behaviour: refusals and reads leave it up, and only an explicit close
// ends it. What DOES end a pairing's window — the machine's first report on the callback channel — is covered by
// verify-handshake.mjs, because it takes two listeners to express.
import { PromptShare } from '../lib/share.js';

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`);
};

/** Let the server's close callback run before asking whether it closed. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 400); });

/** Is anything still listening on this offer's address? */
async function stillListening(offer) {
  const live = await fetch(offer.url);
  return live.status;
}

console.log('\na refused request leaves the listener UP, so the machine can still fetch:');
{
  // The case that was reported: the offer names a specific reader, and the request came from somebody else.
  // This is what an agent whose fetch tool is blocked looks like from here — the tool declined to return the
  // body, but the request arrived.
  const share = new PromptShare();
  const offer = await share.publish({ prompt: 'PROMPT-A', closeAfterFetch: true, minutes: 5, preferAddress: '10.9.9.9' });
  const first = await fetch(offer.url);
  check('a request from the wrong host is refused', first.status === 403, String(first.status));
  await settle();
  check('and the listener is still up afterwards', share.active === true);
  const second = await fetch(offer.url);
  check('so a retry still reaches it', second.status === 403, String(second.status));
  await share.close();
}

console.log('\na wrong path does not close it either:');
{
  const share = new PromptShare();
  const offer = await share.publish({ prompt: 'PROMPT-B', closeAfterFetch: true, minutes: 5 });
  const wrong = await fetch(new URL('/zzzz', offer.url).href);
  check('an unknown path is refused', wrong.status === 404, String(wrong.status));
  await settle();
  check('the listener is still up', share.active === true);
  const right = await fetch(offer.url);
  check('the real address still works', right.status === 200, String(right.status));
  check('and it delivered the prompt', (await right.text()) === 'PROMPT-B');
  await share.close();
}

console.log('\nHEAD asks whether the address answers; that is not a fetch:');
{
  const share = new PromptShare();
  const offer = await share.publish({ prompt: 'PROMPT-C', closeAfterFetch: true, minutes: 5 });
  const head = await fetch(offer.url, { method: 'HEAD' });
  check('HEAD is answered', head.status === 200, String(head.status));
  await settle();
  // An agent may well probe the address before deciding to read it. Treating a probe as a read would close the
  // port on the strength of a question.
  check('HEAD does not close the listener', share.active === true);
  const real = await fetch(offer.url);
  check('the prompt is still there to read', real.status === 200, String(real.status));
  check('and it is the whole prompt', (await real.text()) === 'PROMPT-C');
  await share.close();
}

console.log('\ndelivering the prompt does NOT close it either — the handshake does:');
{
  // This section previously asserted the opposite, and that assertion is what shipped the bug: the listener
  // closed as soon as a response went out, so a machine whose fetch tool refused the body lost the address it
  // needed for its retry. `closeAfterFetch` no longer exists; see verify-handshake.mjs for what replaced it.
  //
  // The flag is still passed here on purpose: an unknown option must be inert, not quietly restore the old
  // behaviour the next time somebody passes it.
  const share = new PromptShare();
  const offer = await share.publish({ prompt: 'PROMPT-D', closeAfterFetch: true, minutes: 5 });
  const read = await fetch(offer.url);
  check('the read succeeds', read.status === 200, String(read.status));
  check('the body is the prompt', (await read.text()) === 'PROMPT-D');
  await settle();
  check('the listener is STILL up after delivering', share.active === true, 'only the handshake ends the window');
  check('and the address still answers', (await reachable(offer.url)) === 'HTTP 200');
  await share.close();
  await settle();
  check('an explicit close does end it', share.active === false);
}

console.log('\nwithout closeAfterFetch the listener stays up for its whole window:');
{
  // The reporting listener is the opposite case and must not inherit this behaviour: it is opened for a run that
  // takes minutes, and every report would otherwise close it after the first one.
  const share = new PromptShare();
  const offer = await share.publish({ prompt: 'PROMPT-E', minutes: 5 });
  const first = await fetch(offer.url);
  check('the first read succeeds', first.status === 200, String(first.status));
  await settle();
  check('the listener is still up', share.active === true);
  const second = await fetch(offer.url);
  check('and can be read again', second.status === 200, String(second.status));
  await share.close();
}

console.log(`\n${failures === 0 ? 'SHARE CLOSING VERIFIED' : `${String(failures)} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
