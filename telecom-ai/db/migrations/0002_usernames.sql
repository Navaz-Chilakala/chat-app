-- Username sign-in (admin bootstrap from ADMIN_USERNAME / ADMIN_PASSWORD); email becomes optional.
ALTER TABLE users ADD COLUMN username citext UNIQUE;
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_identity_present CHECK (email IS NOT NULL OR username IS NOT NULL);
