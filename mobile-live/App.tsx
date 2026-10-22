import { DarkTheme, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { LanguageProvider } from "./src/context/language";
import { theme } from "./src/components/theme";
import type { RootStackParamList } from "./src/navigation";
import { AlertScreen } from "./src/screens/AlertScreen";
import { AssistantScreen } from "./src/screens/AssistantScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import { ScannerScreen } from "./src/screens/ScannerScreen";

const Stack = createNativeStackNavigator<RootStackParamList>();

// Native stack announces the header title to the screen reader on each push,
// and renders a system Back button that TalkBack/VoiceOver already understand.
const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: theme.bg,
    card: theme.bg,
    text: theme.text,
    border: theme.border,
    primary: theme.assistant,
  },
};

export function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <LanguageProvider>
        <NavigationContainer theme={navTheme}>
        <Stack.Navigator
          screenOptions={{
            headerTitleStyle: { fontSize: 24, fontWeight: "800" },
            headerBackTitle: "Back",
            headerLargeTitle: true,
            contentStyle: { backgroundColor: theme.bg },
          }}
        >
          <Stack.Screen
            name="Home"
            component={HomeScreen}
            options={{ title: "Ntentan", headerShown: false }}
          />
          <Stack.Screen
            name="Assistant"
            component={AssistantScreen}
            options={{ title: "Assistant" }}
          />
          <Stack.Screen
            name="Scanner"
            component={ScannerScreen}
            options={{ title: "Scan medication" }}
          />
          <Stack.Screen
            name="Alert"
            component={AlertScreen}
            options={{ title: "Emergency alert" }}
          />
        </Stack.Navigator>
        </NavigationContainer>
      </LanguageProvider>
    </SafeAreaProvider>
  );
}
