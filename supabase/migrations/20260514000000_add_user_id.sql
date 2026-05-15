ALTER TABLE public.gmail_connections
    ADD COLUMN user_id uuid REFERENCES auth.users(id);
CREATE index idx_gmail_connections_user_id ON public.gmail_connections(user_id);