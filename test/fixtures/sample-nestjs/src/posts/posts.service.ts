import { Injectable } from "@nestjs/common";

export interface Post {
  id: number;
  title: string;
}

@Injectable()
export class PostsService {
  private posts: Post[] = [];

  list(): Post[] {
    return this.posts;
  }

  create(input: { title: string }): Post {
    const post = { id: this.posts.length + 1, title: input.title };
    this.posts = [...this.posts, post];
    return post;
  }

  remove(id: number): void {
    this.posts = this.posts.filter((p) => p.id !== id);
  }
}
