import app from './app';
import supabaseRoutes from './routes/supabase';

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`AI Wearable Companion Backend running on port ${PORT}`);
});