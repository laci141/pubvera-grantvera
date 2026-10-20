    const bar     = document.getElementById('authBar');
    const emailEl = document.getElementById('authEmail');
    const inBtn   = document.getElementById('authSignInBtn');
    const outBtn  = document.getElementById('authSignOutBtn');

    // Installed first so the searches and the 401 error card can always ask, even
    // if the config fetch or the script load below never completes.
    window.pubveraAuth = { enabled: false, signIn() {}, signOut() {} };

    async function initAuth() {
      let cfg;
      try {
        const res = await fetch('/config.json', { cache: 'no-store' });
        if (!res.ok) return;
        cfg = await res.json();
      } catch (e) {
        return; // unauthenticated mode
      }
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
        window.pubveraAuth.unavailable = true;
        document.getElementById('authUnavailable').hidden = false;
        bar.hidden = false;
        return;
      }
      const sb = window.supabase.createClient(url, key);
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

      const { data: { session } } = await sb.auth.getSession();
      render(session);
      // Fires on sign-in, sign-out and background token refresh, including the
      // redirect back from Google, which lands here as a new session.
      sb.auth.onAuthStateChange((_event, s) => render(s));
    }

    initAuth().catch(() => { /* stay in unauthenticated mode */ });
