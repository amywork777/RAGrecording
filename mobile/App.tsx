import React, { useEffect, useRef } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { View, Platform, Linking } from 'react-native';

import RecordScreen from './src/screens/RecordScreen';
import ChatScreen from './src/screens/ChatScreen';
import TranscriptionDetailScreen from './src/screens/TranscriptionDetailScreen';
import { useTheme } from './src/theme/colors';
import DeepLinkService from './src/services/DeepLinkService';

const Tab = createBottomTabNavigator();
const Stack = createStackNavigator();

// Tab Navigator Component
function MainTabs() {
  const colors = useTheme();
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        tabBarIcon: ({ focused, color, size }) => {
          let iconName: keyof typeof Ionicons.glyphMap;

          if (route.name === 'Record') {
            iconName = focused ? 'mic-circle' : 'mic-circle-outline';
          } else if (route.name === 'Chat') {
            iconName = focused ? 'chatbubbles' : 'chatbubbles-outline';
          } else {
            iconName = 'alert-circle';
          }

          return (
            <View style={{
              padding: 2,
              borderRadius: 8,
              backgroundColor: focused ? `${colors.primary.main}15` : 'transparent',
            }}>
              <Ionicons name={iconName} size={22} color={color} />
            </View>
          );
        },
        tabBarActiveTintColor: colors.primary.main,
        tabBarInactiveTintColor: colors.text.secondary,
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.background.elevated,
          borderTopWidth: 0,
          elevation: 0,
          shadowOffset: { width: 0, height: -4 },
          shadowColor: '#000',
          shadowOpacity: 0.1,
          shadowRadius: 10,
          height: Platform.OS === 'ios' ? 85 : 65,
          paddingBottom: Platform.OS === 'ios' ? 25 : 10,
          paddingTop: 10,
        },
        tabBarLabelStyle: {
          fontSize: 12,
          fontWeight: '450',
          fontFamily: 'General Sans',
          marginTop: 4,
        },
      })}
    >
      <Tab.Screen 
        name="Record" 
        component={RecordScreen}
        options={{
          tabBarLabel: 'Record',
        }}
      />
      <Tab.Screen 
        name="Chat" 
        component={ChatScreen}
        options={{
          tabBarLabel: 'Chat',
        }}
      />
    </Tab.Navigator>
  );
}

export default function App() {
  
  function handleURL(url: string | null) {
    console.log('Deep link received:', url);
    
    if (!url || !url.includes('tai://')) return;
    
    const action = url.replace('tai://', '').toLowerCase();
    console.log('Parsed action:', action);
    
    // Emit event instead of direct calls
    DeepLinkService.emit('deeplink', { action });
  }

  useEffect(() => {
    const getInitialURL = async () => {
      try {
        const initialUrl = await Linking.getInitialURL();
        handleURL(initialUrl);
      } catch (error) {
        console.log('Error getting initial URL:', error);
      }
    };
    getInitialURL();

    const subscription = Linking.addEventListener('url', ({ url }) => handleURL(url));
    return () => subscription?.remove();
  }, []);

  return (
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{
          headerShown: false,
        }}
      >
        <Stack.Screen 
          name="MainTabs" 
          component={MainTabs}
          options={{ headerShown: false }}
        />
        <Stack.Screen 
          name="TranscriptionDetail" 
          component={TranscriptionDetailScreen}
          options={{ headerShown: false }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
