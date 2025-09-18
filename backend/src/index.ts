import app from './app';

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`AI Wearable Companion Backend running on port ${PORT}`);
});