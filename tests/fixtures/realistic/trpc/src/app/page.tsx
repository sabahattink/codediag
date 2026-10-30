import { api } from "~/trpc/server";

export default async function Home() {
  const posts = await api.post.latest();

  return (
    <main>
      <h1>Notes</h1>
      <ul>
        {posts.map((post) => (
          <li key={post.id}>{post.name}</li>
        ))}
      </ul>
    </main>
  );
}
