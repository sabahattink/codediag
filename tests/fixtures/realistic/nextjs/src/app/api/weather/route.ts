const WEATHER_API = 'https://api.weather.example.com';

export async function GET(request: Request): Promise<Response> {
  const city = new URL(request.url).searchParams.get('city') ?? 'Baku';
  const upstream = await fetch(`${WEATHER_API}/v1/current?city=${encodeURIComponent(city)}`);
  return Response.json(await upstream.json());
}
