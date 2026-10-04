async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalGuards(new JwtGuard());
  app.useGlobalPipes(new ValidationPipe());
}
