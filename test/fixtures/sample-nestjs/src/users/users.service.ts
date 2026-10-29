import { Injectable } from "@nestjs/common";
import type { CreateUserDto } from "./dto/create-user.dto";

export interface User {
  id: number;
  email: string;
  name: string;
}

@Injectable()
export class UsersService {
  private users: User[] = [];

  findAll(): User[] {
    return this.users;
  }

  create(dto: CreateUserDto): User {
    const user = { id: this.users.length + 1, ...dto };
    this.users = [...this.users, user];
    return user;
  }
}
