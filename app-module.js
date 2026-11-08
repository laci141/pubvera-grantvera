    const bar     = document.getElementById('authBar');
    const emailEl = document.getElementById('authEmail');
    const inBtn   = document.getElementById('authSignInBtn');
    const outBtn  = document.getElementById('authSignOutBtn');
    const unavailEl = document.getElementById('authUnavailable');

    // Installed first so the searches and the 401 error card can always ask, even
    // if the config fetch or the script load below never completes.
    window.pubveraAuth = { enabled: false, signIn() {}, signOut() {} };

    // Three states, kept apart on purpose:
    //   disabled     /config.json answered 200 with an empty pair. That is a valid
    //                answer (the current default): no bar, no Supabase, the page
    //                runs unauthenticated.
    //   ready        the Supabase client started.
    //   unavailable  something that should have worked did not. The page says so,
    //                with a reason, and the console gets a short code. Never a
    //                key, a token or the config itself.
    const TEXT_CONFIG = 'Sign-in is unavailable: its configuration could not be loaded.';
    const TEXT_SCRIPT = 'Sign-in is unavailable: a required script did not load.';
    const TEXT_START  = 'Sign-in is unavailable: it could not be started.';
    function failAuth(code, text) {
      window.sb = undefined; // no client, so no token: the API will answer 401
      window.pubveraAuth = { enabled: false, unavailable: true, unavailableText: text, signIn() {}, signOut() {} };
      unavailEl.textContent = text;
      unavailEl.hidden = false;
      emailEl.hidden = true;
      inBtn.hidden = true;
      outBtn.hidden = true;
      bar.hidden = false;
      console.error('[auth] sign-in unavailable: ' + code);
    }

    async function initAuth() {
      let cfg;
      try {
        const res = await fetch('/config.json', { cache: 'no-store' });
        if (!res.ok) return failAuth('config-http-' + res.status, TEXT_CONFIG);
        cfg = await res.json();
      } catch (e) {
        return failAuth('config-unreadable', TEXT_CONFIG);
      }
      if (!cfg || typeof cfg !== 'object') return failAuth('config-shape', TEXT_CONFIG);
      const url = String((cfg && cfg.supabase_url) || '').trim();
      const key = String((cfg && cfg.supabase_anon_key) || '').trim();
      // Either field empty: skip Supabase entirely.
      if (!url || !key) return;

      // supabase-js 2.117.0, UMD build (global `supabase`), pinned with SRI.
      // Injected only here, after the config check, so an unconfigured page
      // still downloads nothing. Not a dynamic import(): it cannot carry an
      // integrity hash, and the previous ESM CDN entry was a stub pulling
      // further modules that included unversioned polyfills (/node/*.mjs).
      // To upgrade: change the version in the URL and recompute the sha384
      //   openssl dgst -sha384 -binary supabase.js | openssl base64 -A
      try {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.0/dist/umd/supabase.js';
          s.integrity = 'sha384-xPW3QHswsICVC2mW6BFNwMbhpLkbZ133fKOhxNx3QGGgAOJfL3O9t8r2aWn1aez6';
          s.crossOrigin = 'anonymous';
          s.onload = resolve;
          s.onerror = reject; // network failure or integrity mismatch
          document.head.appendChild(s);
        });
      } catch (_) {
        // Say so, instead of a sign-in prompt that cannot work.
        return failAuth('script', TEXT_SCRIPT);
      }
      let sb;
      try {
        sb = window.supabase.createClient(url, key);
      } catch (_) {
        return failAuth('client-init', TEXT_START);
      }
      window.sb = sb;

      window.pubveraAuth = {
        enabled: true,
        signIn: async () => {
          const { error } = await sb.auth.signInWithOAuth({
            provider: 'google',
            // Back to the origin the user is actually on, so a sign-in started on
            // grantvera.pubvera.com returns to grantvera.pubvera.com.
            options: { redirectTo: window.location.origin }
          });
          if (error) alert('Sign-in failed: ' + error.message);
        },
        signOut: () => sb.auth.signOut()
      };

      inBtn.onclick  = () => window.pubveraAuth.signIn();
      outBtn.onclick = () => window.pubveraAuth.signOut();

      function render(session) {
        const signedIn = !!session;
        emailEl.textContent = signedIn ? (session.user && session.user.email || 'Signed in') : '';
        emailEl.hidden = !signedIn;
        outBtn.hidden  = !signedIn;
        inBtn.hidden   = signedIn;
        bar.hidden = false; // only now: an empty bar must never flash first
      }

      let session;
      try {
        ({ data: { session } } = await sb.auth.getSession());
      } catch (_) {
        return failAuth('session', TEXT_START);
      }
      render(session);
      // Fires on sign-in, sign-out and background token refresh, including the
      // redirect back from Google, which lands here as a new session.
      sb.auth.onAuthStateChange((_event, s) => render(s));
    }

    initAuth().catch(() => failAuth('unexpected', TEXT_START));
