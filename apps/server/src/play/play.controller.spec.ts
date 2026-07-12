import { Test } from "@nestjs/testing";
import { PlayController } from "./play.controller";
import { PlayService } from "./play.service";
import { CharacterRegistry } from "./character-registry.service";

describe("PlayController", () => {
  const service = {
    createGame: jest.fn(async () => ({ id: "g1" })),
    getGame: jest.fn(() => ({ id: "g1" })),
    getStream: jest.fn(),
    userMove: jest.fn(async () => ({ id: "g1" })),
    resign: jest.fn(async () => ({ id: "g1" })),
    offerDraw: jest.fn(async () => undefined),
    chat: jest.fn(async () => undefined),
  };
  const registry = { list: jest.fn(() => [{ id: "hustler" }]) };
  let controller: PlayController;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      controllers: [PlayController],
      providers: [
        { provide: PlayService, useValue: service },
        { provide: CharacterRegistry, useValue: registry },
      ],
    }).compile();
    controller = module.get(PlayController);
  });

  it("lists characters", () => {
    expect(controller.listCharacters()).toEqual([{ id: "hustler" }]);
  });

  it("creates a game", async () => {
    await controller.create({ characterId: "hustler", side: "white" });
    expect(service.createGame).toHaveBeenCalledWith({
      characterId: "hustler",
      side: "white",
    });
  });

  it("gets a game", () => {
    expect(controller.get("g1")).toEqual({ id: "g1" });
    expect(service.getGame).toHaveBeenCalledWith("g1");
  });

  it("routes moves, resign, draw and chat", async () => {
    await controller.move("g1", { move: "e4" });
    expect(service.userMove).toHaveBeenCalledWith("g1", "e4");
    await controller.resign("g1");
    expect(service.resign).toHaveBeenCalledWith("g1");
    expect(await controller.drawOffer("g1")).toEqual({ accepted: true });
    expect(service.offerDraw).toHaveBeenCalledWith("g1");
    expect(await controller.chat("g1", { text: "hi" })).toEqual({ accepted: true });
    expect(service.chat).toHaveBeenCalledWith("g1", "hi");
  });

  it("streams events", () => {
    controller.events("g1");
    expect(service.getStream).toHaveBeenCalledWith("g1");
  });
});
