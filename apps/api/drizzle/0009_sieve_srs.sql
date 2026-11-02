-- Sender Rewriting Scheme for mail forwarded by Sieve (Postfix port 10588):
-- the envelope sender becomes SRS0=<hash>=<day>=<domain>=<local>@<server>,
-- so SPF passes at the destination and a bounce can be sent back to the
-- original sender. Postfix computes and reverses these addresses through the
-- functions below (it can only read from the database); the key never leaves it.
CREATE TABLE IF NOT EXISTS "srs_key" (
  "id" integer PRIMARY KEY DEFAULT 1 CHECK ("id" = 1),
  "secret" text NOT NULL DEFAULT encode(sha256((gen_random_uuid()::text || clock_timestamp()::text || random()::text)::bytea), 'hex')
);
--> statement-breakpoint
INSERT INTO "srs_key" ("id") VALUES (1) ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Keyed hash of an address and a day: 8 hex characters.
CREATE OR REPLACE FUNCTION mail.srs_hash(day text, domain text, local_part text) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT left(encode(sha256(convert_to(k.secret || '|' || lower(day) || '|' || lower(domain) || '|' || lower(local_part) || '|' || k.secret, 'UTF8')), 'hex'), 8)
  FROM public.srs_key k WHERE k.id = 1
$$;
--> statement-breakpoint
-- Day stamp: days since 1970, modulo 1024, in base 32 (two characters).
CREATE OR REPLACE FUNCTION mail.srs_day(at timestamptz) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$
  SELECT substr('abcdefghijklmnopqrstuvwxyz234567', ((floor(extract(epoch FROM at) / 86400)::bigint % 1024) / 32)::int + 1, 1)
      || substr('abcdefghijklmnopqrstuvwxyz234567', ((floor(extract(epoch FROM at) / 86400)::bigint % 1024) % 32)::int + 1, 1)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION mail.srs_forward(sender text, server text) RETURNS text
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  at_pos integer := length(sender) - position('@' IN reverse(sender)) + 1;
  local_part text;
  domain text;
  day text := mail.srs_day(now());
BEGIN
  IF sender IS NULL OR position('@' IN sender) = 0 THEN RETURN NULL; END IF;
  local_part := left(sender, at_pos - 1);
  domain := lower(substr(sender, at_pos + 1));
  IF local_part = '' OR domain = '' OR domain = lower(server) OR local_part ~* '^srs[01][=+-]' THEN RETURN NULL; END IF;
  RETURN 'SRS0=' || mail.srs_hash(day, domain, local_part) || '=' || day || '=' || domain || '=' || local_part || '@' || server;
END
$$;
--> statement-breakpoint
-- The original address, if `address` is a valid SRS0 address of the last 21 days.
CREATE OR REPLACE FUNCTION mail.srs_reverse(address text) RETURNS text
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  parts text[] := regexp_match(address, '^srs0=([0-9a-f]{8})=([a-z2-7]{2})=([^=@]+)=(.+)@[^@]+$', 'i');
  age integer;
  i integer;
BEGIN
  IF parts IS NULL THEN RETURN NULL; END IF;
  IF lower(parts[1]) <> mail.srs_hash(parts[2], parts[3], parts[4]) THEN RETURN NULL; END IF;
  age := NULL;
  FOR i IN 0..21 LOOP
    IF lower(parts[2]) = mail.srs_day(now() - make_interval(days => i)) THEN age := i; EXIT; END IF;
  END LOOP;
  IF age IS NULL THEN RETURN NULL; END IF;
  RETURN parts[4] || '@' || lower(parts[3]);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION mail.srs_hash(text, text, text) FROM PUBLIC;
