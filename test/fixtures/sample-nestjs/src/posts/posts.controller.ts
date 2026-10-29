import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PostsService, type Post as BlogPost } from "./posts.service";

export class UpdatePostDto {
  title!: string;
}

@Controller({ path: "posts", version: "1" })
export class PostsController {
  constructor(private readonly posts: PostsService) {}

  // No Swagger docs and no return type (info issues).
  @Get()
  list() {
    return this.posts.list();
  }

  // No guard and an untyped body (warnings).
  @Post()
  create(@Body() body: any): BlogPost {
    return this.posts.create(body);
  }

  // No guard (warning).
  @Delete(":id")
  remove(@Param("id") id: string): void {
    this.posts.remove(Number(id));
  }

  @Patch(":id")
  @UseGuards(JwtAuthGuard)
  update(@Param("id") id: string, @Body() dto: UpdatePostDto): BlogPost {
    return { id: Number(id), title: dto.title };
  }
}
