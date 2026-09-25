const GAS_URL = 'https://script.google.com/macros/s/AKfycbyKSkm1rv1SEVrb_F92Zs10iFO31zs7g_6KWMRYAvdUORkCvA3pMrk9VZI0Fdi5aRky/exec';

export default {
  async fetch(request, env, ctx) {
    let raw = '';
    try {
      raw = await request.text();
    } catch (e) {}

    ctx.waitUntil(
      fetch(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: raw
      }).then((r) => r.text()).catch((e) => console.error('GAS forward error:', String(e)))
    );

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};