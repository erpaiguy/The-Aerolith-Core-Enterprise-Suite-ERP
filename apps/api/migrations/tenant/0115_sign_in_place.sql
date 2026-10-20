-- Wave 9 step 9a.3 (docs/wave9-plan.md): where each sign-in came from, so the welcome after signing in can say when
-- and where the person last signed in, and a sign-in they do not recognise stands out.
ALTER TABLE platform.session
  ADD COLUMN ip text CHECK (ip IS NULL OR length(ip) <= 64),
  ADD COLUMN user_agent text CHECK (user_agent IS NULL OR length(user_agent) <= 300);
