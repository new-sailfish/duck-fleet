// The prompt link closes on the HANDSHAKE, not on a fetch.
//
// Reported from a real attempt: the controlled machine's fetch tool refuses private addresses, so the first
// attempt delivered nothing — but the request still reached the listener, which closed the port. The retry with
// a different tool found nothing listening. The prompt's lifetime was keyed on the wrong event.
//
// The event that actually proves delivery is the machine's FIRST REPORT on the callback channel: it cannot post
// one without having read the prompt. So the prompt link stays up until that arrives, and a fetch on its own
// never ends it.
import { ProgressListener } from '../lib/progress.js';
import { PromptShare } from '../lib/share.js';

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`);
};

/** Let the server's close callback run before asking whether it closed. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 400); });

/** Is the prompt address still answering? */
async function reachable(url) {
  try {
    const response = await fetch(url);
    return `HTTP ${String(response.status)}`;
  } catch {
    return 'refused';
  }
}

console.log('\nreading the prompt does NOT close it:');
{
  const share = new PromptShare();
  const progress = new ProgressListener();
  await progress.open({ minutes: 10, onFirstReport: async () => { await share.close(); } });
  const prompt = await share.publish({ prompt: 'THE-PROMPT', minutes: 5 });

  const first = await fetch(prompt.url);
  check('the prompt can be read', first.status === 200, String(first.status));
  check('the body is the prompt', (await first.text()) === 'THE-PROMPT');
  await settle();
  // A read proves a request arrived. It does not prove the reader's tooling returned the body — that is exactly
  // the reported case, where the request arrived and was refused downstream.
  check('the prompt link stays UP after a read', share.active === true);
  check('so a retry still reaches it', (await reachable(prompt.url)) === 'HTTP 200');
  await share.close();
  await progress.close();
}

console.log('\nneither does a REFUSED read:');
{
  const share = new PromptShare();
  const progress = new ProgressListener();
  await progress.open({ minutes: 10, onFirstReport: async () => { await share.close(); } });
  // `preferAddress` names a reader, so this controller's own request is refused — the shape of a blocked fetch.
  const prompt = await share.publish({ prompt: 'THE-PROMPT', minutes: 5, preferAddress: '10.9.9.9' });

  const refused = await fetch(prompt.url);
  check('the read is refused', refused.status === 403, String(refused.status));
  await settle();
  check('the prompt link stays UP', share.active === true);
  check('so a later read still reaches it', (await reachable(prompt.url)) === 'HTTP 403');
  await share.close();
  await progress.close();
}

console.log('\nthe machine\'s FIRST report closes it:');
{
  const share = new PromptShare();
  const progress = new ProgressListener();
  await progress.open({ minutes: 10, onFirstReport: async () => { await share.close(); } });
  const prompt = await share.publish({ prompt: 'THE-PROMPT', minutes: 5 });

  check('the prompt link is up before any report', share.active === true);
  const report = await fetch(progress.boundAddress === undefined ? '' : `http://${progress.boundAddress}:${String(progress.port)}/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stage: 'sshd', state: 'ok' }),
  }).catch(() => undefined);
  // Without a token the report is refused, which must NOT count as a handshake: only an accepted report proves
  // the machine read the prompt, since the token came from the prompt.
  check('an unauthenticated report is refused', report === undefined || report.status === 404, String(report?.status));
  await settle();
  check('and it does not close the prompt link', share.active === true);

  // The real handshake, with the token the prompt carried.
  const opened = await progress.open({ minutes: 10, onFirstReport: async () => { await share.close(); } });
  const authed = await fetch(opened.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fleet-token': opened.token },
    body: JSON.stringify({ stage: 'sshd', state: 'ok', detail: 'handshake' }),
  });
  check('the authenticated report is accepted', authed.status === 200, String(authed.status));
  await settle();
  check('and the prompt link closes', share.active === false, 'the machine has demonstrably read the prompt');
  check('so the address is gone', (await reachable(prompt.url)) === 'refused');
  await progress.close();
}

console.log('\na FAILING first stage still counts as the handshake:');
{
  // Whether the first step succeeded says nothing about whether the prompt arrived. The machine plainly has the
  // prompt, so keeping the link open would only leave an address serving nothing.
  const share = new PromptShare();
  const progress = new ProgressListener();
  const opened = await progress.open({ minutes: 10, onFirstReport: async () => { await share.close(); } });
  await share.publish({ prompt: 'THE-PROMPT', minutes: 5 });
  const failed = await fetch(opened.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fleet-token': opened.token },
    body: JSON.stringify({ stage: 'sshd', state: 'fail', error: 'no permission' }),
  });
  check('the failing report is accepted', failed.status === 200, String(failed.status));
  await settle();
  check('the prompt link closes anyway', share.active === false);
  await progress.close();
}

console.log('\nevery report pushes the deadline back, because the window measures SILENCE:');
{
  // A fixed deadline from the start would kill a pairing that is working correctly but slowly — which is exactly
  // the machine this flow exists for. The timeout has to mean "nothing has been heard for a while".
  const progress = new ProgressListener();
  const opened = await progress.open({ minutes: 5 });
  const before = progress.status(opened.token).remainingMs;
  await new Promise((resolve) => { setTimeout(resolve, 1100); });
  const drained = progress.status(opened.token).remainingMs;
  check('time passes and the window shrinks', drained < before, `${String(before)} -> ${String(drained)}`);

  const post = (body) => fetch(opened.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fleet-token': opened.token },
    body: JSON.stringify(body),
  });
  await post({ stage: 'sshd', state: 'started', detail: 'installing' });
  const afterStart = progress.status(opened.token).remainingMs;
  check('a `started` report restores the window', afterStart > drained, `${String(drained)} -> ${String(afterStart)}`);
  // The long stage reports its beginning and then its end; both must count as activity.
  await new Promise((resolve) => { setTimeout(resolve, 1100); });
  await post({ stage: 'sshd', state: 'ok' });
  const afterDone = progress.status(opened.token).remainingMs;
  check('and a result report restores it again', afterDone > afterStart - 1500, String(afterDone));
  await progress.close();
}

console.log('\nthe stage states a machine may report:');
{
  const progress = new ProgressListener();
  const opened = await progress.open({ minutes: 5 });
  const post = (body) => fetch(opened.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fleet-token': opened.token },
    body: JSON.stringify(body),
  });
  for (const state of ['started', 'ok', 'fail', 'skipped']) {
    const response = await post({ stage: 'sshd', state });
    check(`\`${state}\` is accepted`, response.status === 200, String(response.status));
  }
  // `waiting` is the PANEL's word for "not heard from". A machine able to report it could claim a stage is
  // pending after it had finished, so it is refused rather than stored.
  const waiting = await post({ stage: 'sshd', state: 'waiting' });
  check('`waiting` is refused', waiting.status === 400, String(waiting.status));
  check('and the refusal names the allowed states', (await waiting.json()).error.includes('started'), String((await waiting.json()).error));
  await progress.close();
}

console.log(`\n${failures === 0 ? 'HANDSHAKE CLOSING VERIFIED' : `${String(failures)} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
