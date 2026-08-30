package dev.udmc.sync;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.Screen;

final class ClientPlatform {
    static Screen screen() { return Minecraft.getInstance().screen; }
    static void open(Screen screen) { Minecraft.getInstance().setScreen(screen); }
}
