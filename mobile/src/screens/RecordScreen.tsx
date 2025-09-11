import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  SafeAreaView,
  Animated,
  Dimensions,
  TextInput,
  AppState,
  Switch,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import BLEService from '../services/BLEService';
import BLEFileTransferService from '../services/BLEFileTransferService';
import APIService from '../services/APIService';
import AudioRecordingService from '../services/AudioRecordingService';
import DeepLinkService from '../services/DeepLinkService';
import uuid from 'react-native-uuid';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import SecureStorageService from '../services/SecureStorageService';
import WebhookService from '../services/WebhookService';
import TranscriptStorageService from '../services/TranscriptStorageService';
import { Buffer } from 'buffer';
import { useTheme, spacing, borderRadius, typography, shadows } from '../theme/colors';

const { width } = Dimensions.get('window');

// Auto-scan configuration
const AUTO_SCAN_STORAGE_KEY = 'auto_scan_enabled';
const AUTO_SCAN_INTERVAL_MS = 30000; // 30 seconds
const AUTO_SCAN_TIMEOUT_MS = 8000; // 8 seconds scan duration

interface Transcript {
  id: string;
  text: string;
  title?: string;
  summary?: string;
  timestamp: Date;
  isExpanded?: boolean;
  path?: string; // ZeroEntropy document path when available
  aiTitle?: string;
  aiSummary?: string;
  durationSeconds?: number | null;
  duration_seconds?: number | null;
  localAudioPath?: string; // Local WAV/M4A file path
  remoteAudioUrl?: string; // Backend audio URL
  source?: 'ble' | 'recording' | 'upload'; // Track where audio came from
}

export default function RecordScreen({ route }: any) {
  const colors = useTheme();
  const styles = createStyles(colors);
  const navigation = useNavigation();
  const [isConnected, setIsConnected] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isBackgroundRecording, setIsBackgroundRecording] = useState(false);
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [currentRecordingId, setCurrentRecordingId] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isUploadingAudio, setIsUploadingAudio] = useState(false);
  const pulseAnim = new Animated.Value(1);
  const [recordingTime, setRecordingTime] = useState(0);
  const [intervalId, setIntervalId] = useState<NodeJS.Timeout | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const scrollViewRef = useRef<ScrollView>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filteredTranscripts, setFilteredTranscripts] = useState<Transcript[]>([]);
  
  // BLE device states
  const [availableDevices, setAvailableDevices] = useState<any[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<any | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState(0);
  const [showUploadOptions, setShowUploadOptions] = useState(false);
  
  // Auto-scanning states - always enabled
  const [autoScanEnabled, setAutoScanEnabled] = useState(true);
  const [isAutoScanning, setIsAutoScanning] = useState(false);
  const [lastAutoScanTime, setLastAutoScanTime] = useState<Date | null>(null);
  const [autoScanInterval, setAutoScanInterval] = useState<NodeJS.Timeout | null>(null);
  const [appState, setAppState] = useState(AppState.currentState);

  // Webhook integration states
  const [isWebhookMonitoring, setIsWebhookMonitoring] = useState(false);
  const [isTranscriptionCollapsed, setIsTranscriptionCollapsed] = useState(false);
  const [isHardwareRecording, setIsHardwareRecording] = useState(false);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [realtimeTranscripts, setRealtimeTranscripts] = useState<any[]>([]);
  const [webhookRecordingDuration, setWebhookRecordingDuration] = useState(0);

  // Handle deep linking via events
  useEffect(() => {
    const handleDeepLink = (data: { action: string }) => {
      console.log('RecordScreen: Received deep link:', data.action);
      
      setTimeout(() => {
        if (data.action === 'record' || data.action === 'start') {
          console.log('RecordScreen: Starting recording from deep link');
          if (!isRecording) {
            toggleRecording();
          }
        } else if (data.action === 'stop') {
          console.log('RecordScreen: Stopping recording from deep link');
          if (isRecording) {
            toggleRecording();
          }
        } else if (data.action === 'toggle') {
          console.log('RecordScreen: Toggling recording from deep link');
          toggleRecording();
        }
      }, 500);
    };

    DeepLinkService.on('deeplink', handleDeepLink);
    
    return () => {
      DeepLinkService.off('deeplink', handleDeepLink);
    };
  }, [isRecording]);

  // Handle app state changes to maintain recording in background
  useEffect(() => {
    const handleAppStateChange = (nextAppState: string) => {
      console.log('App state changed to:', nextAppState);
      
      if (nextAppState === 'background' && isRecording) {
        console.log('App backgrounded while recording - enabling background mode');
        setIsBackgroundRecording(true);
      } else if (nextAppState === 'active') {
        if (isRecording && isBackgroundRecording) {
          console.log('App foregrounded while background recording - recording still active');
        }
        setIsBackgroundRecording(false);
      }
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    
    return () => {
      subscription?.remove();
    };
  }, [isRecording, isBackgroundRecording]);

  useEffect(() => {
    BLEService.on('deviceConnected', handleDeviceConnected);
    BLEService.on('deviceDisconnected', handleDeviceDisconnected);
    BLEService.on('audioChunk', handleAudioChunk);

    // Setup webhook event listeners
    WebhookService.on('recordingStarted', handleWebhookRecordingStarted);
    WebhookService.on('liveTranscript', handleWebhookLiveTranscript);
    WebhookService.on('recordingEnded', handleWebhookRecordingEnded);
    WebhookService.on('conversationCompleted', handleConversationCompleted);
    WebhookService.on('monitoringStarted', () => setIsWebhookMonitoring(true));
    WebhookService.on('monitoringStopped', () => setIsWebhookMonitoring(false));

    // Load local transcripts first for immediate display
    initializeTranscripts();

    // Auto-start webhook monitoring
    WebhookService.startMonitoring();

    return () => {
      BLEService.removeAllListeners();
      WebhookService.removeAllListeners();
      WebhookService.stopMonitoring();
      if (intervalId) clearInterval(intervalId);
    };
  }, [currentRecordingId]);

  // Load auto-scan preference from storage
  useEffect(() => {
    loadAutoScanPreference();
  }, []);

  // Handle app state changes for smart scanning
  useEffect(() => {
    const handleAppStateChange = (nextAppState: string) => {
      console.log('App state changed:', appState, '->', nextAppState);
      setAppState(nextAppState);
      
      // Log background transition for debugging
      if (nextAppState.match(/inactive|background/)) {
        console.log('App backgrounded - relying on iOS background modes for BLE scanning');
      } else if (nextAppState === 'active') {
        console.log('App foregrounded - full scanning capabilities restored');
      }
      
      // Always keep auto-scanning running in all states if enabled
      if (autoScanEnabled && !autoScanInterval) {
        console.log('Auto-scan enabled, maintaining continuous scanning');
        startAutoScan();
      }
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription?.remove();
  }, [autoScanEnabled, appState, autoScanInterval]);

  // Manage auto-scan interval - runs in all app states
  useEffect(() => {
    if (autoScanEnabled && !isScanning && !isSyncing) {
      console.log('Starting continuous auto-scan (all app states)');
      startAutoScan();
    } else if (!autoScanEnabled) {
      console.log('Stopping auto-scan (disabled by user)');
      stopAutoScan();
    }

    return () => {
      if (autoScanInterval) {
        clearInterval(autoScanInterval);
      }
    };
  }, [autoScanEnabled, isScanning, isSyncing]);

  // Handle navigation from Chat screen
  useEffect(() => {
    if (route?.params?.transcriptId) {
      setHighlightedId(route.params.transcriptId);
      // Scroll to the transcript after a short delay
      setTimeout(() => {
        const index = transcripts.findIndex(t => t.id === route.params.transcriptId);
        if (index !== -1) {
          // Expand the transcript
          toggleExpand(route.params.transcriptId);
        }
      }, 500);
    }
  }, [route?.params?.transcriptId, transcripts]);

  useEffect(() => {
    if (isRecording) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.2,
            duration: 1000,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 1000,
            useNativeDriver: true,
          }),
        ])
      ).start();

      const timer = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
      setIntervalId(timer);
    } else {
      pulseAnim.setValue(1);
      if (intervalId) {
        clearInterval(intervalId);
        setIntervalId(null);
      }
      setRecordingTime(0);
    }
  }, [isRecording]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Generate AI title and summary for transcripts that don't have them
  const generateTitleAndSummary = async (text: string): Promise<{ title: string; summary: string }> => {
    try {
      console.log('🤖 Generating AI title and summary for text:', text.slice(0, 100) + '...');
      const result = await APIService.generateTitleAndSummary(text);
      console.log('✅ Generated title:', result.title);
      console.log('✅ Generated summary:', result.summary);
      return result;
    } catch (error) {
      console.error('❌ Failed to generate title/summary:', error);
      // Fallback to simple text-based title/summary
      const title = text.split('\n')[0]?.slice(0, 50) || 'Untitled Recording';
      const summary = text.slice(0, 160) + (text.length > 160 ? '...' : '');
      return { title, summary };
    }
  };

  // Initialize transcripts: load from local storage first, then sync with backend
  const initializeTranscripts = async () => {
    try {
      console.log('🚀 Initializing transcripts...');
      
      // 1. Load from local storage first for immediate display
      const storedTranscripts = await TranscriptStorageService.loadTranscripts();
      if (storedTranscripts.length > 0) {
        console.log(`📱 Loaded ${storedTranscripts.length} transcripts from local storage`);
        setTranscripts(storedTranscripts);
        setFilteredTranscripts(storedTranscripts);
      }
      
      // 2. Then sync with backend (with small delay to show local data first)
      setTimeout(() => {
        console.log('🔄 Syncing with backend...');
        loadTranscriptsFromBackend();
      }, 500);
      
    } catch (error) {
      console.error('❌ Failed to initialize transcripts:', error);
      // Fallback to just backend loading
      loadTranscriptsFromBackend();
    }
  };

  const loadTranscriptsFromBackend = async () => {
    try {
      console.log('Loading transcripts from backend...');
      const recentTranscripts = await APIService.getRecentTranscripts(100);
      console.log('📡 Received', recentTranscripts?.length, 'transcripts from backend');
      
      // Debug: Show the IDs and timestamps of what we got from backend
      console.log('🔍 Backend transcript IDs and timestamps:');
      recentTranscripts?.slice(0, 5).forEach((t, i) => {
        console.log(`  ${i+1}. ID:${t.id} - ${t.timestamp} - ${t.title || t.aiTitle || 'No title'}`);
      });
      
      // Debug: Check if any recording IDs from recent recordings are in the backend response
      const recentRecordingIds = transcripts.slice(0, 3).map(t => t.id);
      console.log('🔍 Recent local recording IDs:', recentRecordingIds);
      const foundIds = recentTranscripts?.filter(t => recentRecordingIds.includes(t.id)).map(t => t.id) || [];
      console.log('✅ Found these recent IDs in backend:', foundIds);
      const missingIds = recentRecordingIds.filter(id => !foundIds.includes(id));
      console.log('❌ Missing these recent IDs from backend:', missingIds);
      
      if (recentTranscripts && recentTranscripts.length > 0) {
        // Create a map of current transcripts to preserve local audio paths
        const localTranscriptMap = new Map(
          transcripts.map(t => [t.id, t])
        );
        
        // Process backend transcripts - show immediately, generate AI titles/summaries in background
        const backendTranscripts: Transcript[] = recentTranscripts.map((t: any) => {
          const textContent = t.text || t.transcription || '';
          
          // Debug title/summary data from backend
          console.log(`🔍 Processing transcript ${t.id}:`);
          console.log(`  - text: "${textContent?.slice(0, 50)}..."`);
          console.log(`  - title: "${t.title}"`);
          console.log(`  - aiTitle: "${t.aiTitle}"`);
          console.log(`  - summary: "${t.summary}"`);
          console.log(`  - aiSummary: "${t.aiSummary}"`);
          
          // Check if we need to fix "no speech detected" titles/summaries
          const hasNoSpeechTitle = t.title && t.title.toLowerCase().includes('no speech detected');
          const hasNoSpeechAiTitle = t.aiTitle && t.aiTitle.toLowerCase().includes('no speech detected');
          const hasNoSpeechSummary = t.summary && t.summary.toLowerCase().includes('recording did not contain');
          const hasValidText = textContent && textContent.trim().length > 0 && !textContent.toLowerCase().includes('no speech detected');
          
          // Fallback titles/summaries for immediate display
          let displayTitle = t.title;
          let displayAiTitle = t.aiTitle;
          let displaySummary = t.summary;
          let displayAiSummary = t.aiSummary;
          
          // If we have valid text but "no speech detected" titles, generate AI ones
          if (hasValidText && (hasNoSpeechTitle || hasNoSpeechAiTitle || hasNoSpeechSummary)) {
            console.log(`🔄 Will generate AI title for transcript with valid text: ${t.id}`);
            // Generate in background without blocking
            setTimeout(async () => {
              try {
                console.log(`🤖 Generating AI title/summary for transcript ${t.id}`);
                const generated = await generateTitleAndSummary(textContent);
                
                // Update transcript in state
                setTranscripts(prev => prev.map(transcript => 
                  transcript.id === t.id 
                    ? { 
                        ...transcript, 
                        aiTitle: generated.title,
                        aiSummary: generated.summary,
                        title: hasNoSpeechTitle ? generated.title : transcript.title,
                        summary: hasNoSpeechSummary ? generated.summary : transcript.summary
                      } 
                    : transcript
                ));
                setFilteredTranscripts(prev => prev.map(transcript => 
                  transcript.id === t.id 
                    ? { 
                        ...transcript, 
                        aiTitle: generated.title,
                        aiSummary: generated.summary,
                        title: hasNoSpeechTitle ? generated.title : transcript.title,
                        summary: hasNoSpeechSummary ? generated.summary : transcript.summary
                      } 
                    : transcript
                ));
                console.log(`✅ Updated transcript ${t.id} with AI title: "${generated.title}"`);
              } catch (error) {
                console.error(`❌ Failed to generate AI title for ${t.id}:`, error);
              }
            }, Math.random() * 2000 + 1000); // Random delay 1-3 seconds to spread out API calls
          }
          
          // Create fallback if no valid title exists
          const fallbackTitle = (textContent && textContent.trim().length > 0) 
            ? (textContent.split('\n')[0] || textContent).slice(0, 50) 
            : 'Untitled';
          const fallbackSummary = (textContent && textContent.trim().length > 0) 
            ? (textContent.slice(0, 160) + (textContent.length > 160 ? '…' : '')) 
            : 'No summary available';
          
          // Check if we have local data for this transcript
          const localData = localTranscriptMap.get(t.id);
          
          return {
            id: t.id,
            text: textContent || '[No content]',
            title: t.title || fallbackTitle,
            summary: t.summary || fallbackSummary,
            timestamp: new Date(t.timestamp),
            path: t.path,
            aiTitle: t.aiTitle || t.title || fallbackTitle,
            aiSummary: t.aiSummary || t.summary || fallbackSummary,
            durationSeconds: t.durationSeconds ?? t.duration_seconds ?? null,
            // Preserve local audio path if we have it
            localAudioPath: localData?.localAudioPath,
            remoteAudioUrl: t.audioUrl || localData?.remoteAudioUrl,
            source: localData?.source || 'backend',
          } as any;
        });

        // Find transcripts that are local-only (not yet in backend) - be more aggressive about preserving recent ones
        const currentTime = new Date().getTime();
        const localOnlyTranscripts = transcripts.filter(localT => {
          const foundInBackend = backendTranscripts.some(backendT => backendT.id === localT.id);
          const age = currentTime - new Date(localT.timestamp).getTime();
          const isVeryRecent = age < 300000; // 5 minutes
          
          if (!foundInBackend) {
            if (isVeryRecent || localT.localAudioPath || localT.source === 'recording') {
              console.log(`🛡️ Preserving local transcript not yet in backend: ${localT.id} (age: ${Math.round(age/1000)}s, source: ${localT.source})`);
              return true;
            }
          }
          return false;
        });
        
        // Combine and sort by timestamp (newest first)
        const mergedTranscripts = [...localOnlyTranscripts, ...backendTranscripts]
          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        
        // Final deduplication by ID to prevent React key conflicts
        const deduplicatedTranscripts = mergedTranscripts.reduce((acc, current) => {
          const existingIndex = acc.findIndex(t => t.id === current.id);
          if (existingIndex === -1) {
            acc.push(current);
          } else {
            // Keep the one with more complete data (prefer backend data with titles/summaries)
            if (current.title && current.summary && !acc[existingIndex].title) {
              acc[existingIndex] = current;
            }
          }
          return acc;
        }, [] as Transcript[]);
        
        console.log(`🔀 Merging transcripts: ${localOnlyTranscripts.length} local-only + ${backendTranscripts.length} backend = ${mergedTranscripts.length} merged -> ${deduplicatedTranscripts.length} deduplicated`);
        
        // Debug: Show final transcript order
        console.log('🏆 Final transcript order (top 3):');
        deduplicatedTranscripts.slice(0, 3).forEach((t, i) => {
          console.log(`  ${i+1}. ID:${t.id} - ${t.timestamp} - ${t.aiTitle || t.title || 'No title'}`);
        });
        
        setTranscripts(deduplicatedTranscripts);
        setFilteredTranscripts(deduplicatedTranscripts);
        
        // Save merged transcripts to local storage for persistence
        await TranscriptStorageService.saveTranscripts(deduplicatedTranscripts);
        
        console.log('✅ Transcripts state updated with merged data and saved to local storage');
      }
    } catch (error) {
      console.error('Error loading transcripts:', error);
    }
  };

  // Filter transcripts based on search query
  useEffect(() => {
    console.log('Filtering transcripts, total:', transcripts.length, 'search:', searchQuery);
    if (!searchQuery.trim()) {
      setFilteredTranscripts(transcripts);
    } else {
      const query = searchQuery.toLowerCase();
      const filtered = transcripts.filter(transcript => {
        const title = (transcript.aiTitle || transcript.title || '').toLowerCase();
        const summary = (transcript.aiSummary || transcript.summary || '').toLowerCase();
        const text = (transcript.text || '').toLowerCase();
        
        return title.includes(query) || summary.includes(query) || text.includes(query);
      });
      setFilteredTranscripts(filtered);
    }
    console.log('Filtered transcripts count:', filteredTranscripts.length);
  }, [searchQuery, transcripts]);

  const formatDuration = (seconds?: number | null) => {
    if (!seconds || seconds <= 0) return 'N/A';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const buildReportText = (t: any) => {
    const dateStr = t.timestamp?.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) || '';
    const timeStr = t.timestamp?.toLocaleTimeString() || '';
    const durStr = formatDuration(t.durationSeconds ?? t.duration_seconds);
    const title = t.aiTitle || t.title || 'Untitled';
    const summary = t.aiSummary || '—';
    const fullText = (t.text && t.text.trim().length > 0) ? t.text : '[No speech detected]';
    return `📄 Taya Transcription Report\n\n📅 Date: ${dateStr}\n🕐 Time: ${timeStr}\n⏱️ Duration: ${durStr}\n\nAI Title \n${title}\n\n🤖 AI Summary:\n${summary}\n\n📝 Full Transcription:\n${fullText}\n\n---\nGenerated by Taya App\nAI-powered voice companion`;
  };

  const copyReport = async (t: any) => {
    const text = buildReportText(t);
    await Clipboard.setStringAsync(text);
    Alert.alert('Copied', 'Report copied to clipboard');
  };

  const handleDeviceConnected = () => {
    setIsConnected(true);
    Alert.alert('Connected', 'Successfully connected to AI Wearable');
  };

  const handleDeviceDisconnected = () => {
    setIsConnected(false);
    setIsRecording(false);
    Alert.alert('Disconnected', 'Disconnected from AI Wearable');
  };

  const handleAudioChunk = async (audioData: ArrayBuffer) => {
    if (!currentRecordingId) return;

    try {
      const response = await APIService.sendAudioBase64(audioData.toString(), currentRecordingId);
      
      if (response.transcription) {
        const newTranscript: Transcript = {
          id: uuid.v4() as string,
          text: response.transcription,
          title: response.title,
          summary: response.summary,
          timestamp: new Date(response.timestamp),
        };
        
        setTranscripts(prev => [newTranscript, ...prev]);
      }
    } catch (error) {
      console.error('Error processing audio chunk:', error);
    }
  };

  // Webhook event handlers
  const handleWebhookRecordingStarted = (data: any) => {
    console.log('🎙️ Hardware recording started:', data);
    setIsHardwareRecording(true);
    setCurrentConversationId(data.conversationId);
    setRealtimeTranscripts([]);
    setWebhookRecordingDuration(0);
    
    // Start duration timer
    const startTime = Date.now();
    const timer = setInterval(() => {
      setWebhookRecordingDuration(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    
    // Store timer reference for cleanup
    setTimeout(() => clearInterval(timer), 300000); // Auto-clear after 5 minutes
  };

  const handleWebhookLiveTranscript = (data: any) => {
    console.log('📝 Live transcription update:', data.segments.length, 'new segments,', data.totalSegments, 'total');
    
    // Add timestamp to each segment for display
    const segmentsWithTimestamp = data.segments.map((segment: any) => ({
      ...segment,
      receivedAt: new Date(),
      conversationId: data.sessionId || 'webhook-live'
    }));
    
    // Only add new segments that aren't already in the list to prevent duplicates
    setRealtimeTranscripts(prev => {
      const newSegments = segmentsWithTimestamp.filter(newSeg => 
        !prev.some(existingSeg => 
          existingSeg.text === newSeg.text && 
          existingSeg.speaker === newSeg.speaker &&
          Math.abs((existingSeg.receivedAt?.getTime() || 0) - (newSeg.receivedAt?.getTime() || 0)) < 5000 // Within 5 seconds
        )
      );
      
      if (newSegments.length > 0) {
        console.log(`Adding ${newSegments.length} new segments (${prev.length} existing)`);
        // Keep only the last 50 segments to prevent memory bloat
        return [...prev, ...newSegments].slice(-50);
      }
      
      return prev;
    });
  };

  const handleWebhookRecordingEnded = (data: any) => {
    console.log('⏹️ Hardware recording ended:', data.reason, `Duration: ${data.duration}ms`);
    setIsHardwareRecording(false);
    setCurrentConversationId(null);
    setWebhookRecordingDuration(0);
    
    // Convert webhook transcription to regular transcript format and save
    if (realtimeTranscripts.length > 0) {
      const webhookText = realtimeTranscripts
        .map(segment => `[${segment.speaker || 'Speaker'}] ${segment.text}`)
        .join('\n');
      
      const webhookTranscript: Transcript = {
        id: uuid.v4() as string,
        text: webhookText,
        title: `Webhook Recording - ${data.reason}`,
        summary: `Hardware recording captured ${realtimeTranscripts.length} segments over ${Math.round(data.duration / 1000)}s`,
        timestamp: new Date(),
        aiTitle: 'Hardware Transcription',
        aiSummary: `Captured via webhook monitoring (${data.reason})`
      };
      
      setTranscripts(prev => [webhookTranscript, ...prev]);
      console.log('💾 Saved webhook transcription with', realtimeTranscripts.length, 'segments');
      
      // Clear realtime transcripts after saving
      setRealtimeTranscripts([]);
    }
  };

  const handleConversationCompleted = async (data: any) => {
    console.log('📋 Conversation completed:', data.conversation.id);
    
    // Create a transcript from the conversation
    const conversation = data.conversation;
    const fullText = conversation.transcripts.map((t: any) => t.text).join(' ');
    
    if (fullText.trim().length > 0) {
      // Initial transcript with temporary title
      const tempTranscript: Transcript = {
        id: conversation.id,
        text: fullText,
        title: 'Generating AI title...',
        summary: data.summary,
        timestamp: new Date(conversation.startTime),
        aiTitle: 'Generating AI title...',
        aiSummary: data.summary,
        durationSeconds: Math.floor((new Date(conversation.endTime).getTime() - new Date(conversation.startTime).getTime()) / 1000),
        source: 'hardware',
      };
      
      setTranscripts(prev => [tempTranscript, ...prev]);
      setFilteredTranscripts(prev => [tempTranscript, ...prev]);
      
      // Save to backend and get AI-generated title
      try {
        // Convert transcript segments format for webhook API
        const transcriptSegments = conversation.transcripts.map((t: any, index: number) => ({
          speaker: `Speaker ${index + 1}`,
          text: t.text,
          start: index * 3, // Estimate timing
          end: (index + 1) * 3,
          confidence: t.confidence || 0.8,
          timestamp: t.timestamp || new Date().toISOString()
        }));

        const response = await fetch('https://backend-henna-tau-11.vercel.app/api/webhook-transcription/store', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            recordingId: conversation.id,
            sessionId: conversation.id,
            transcriptSegments,
            metadata: {
              source: 'hardware-mobile-app',
              deviceId: 'mobile-device',
              startTime: conversation.startTime,
              endTime: conversation.endTime
            }
          })
        });

        if (response.ok) {
          const result = await response.json();
          console.log('✅ Backend returned AI title:', result.title);
          
          // Update transcript with AI-generated title
          const updatedTranscript: Transcript = {
            ...tempTranscript,
            title: result.title || 'Hardware Recording',
            aiTitle: result.title || 'Hardware Recording',
            summary: result.summary || data.summary,
            aiSummary: result.summary || data.summary,
          };
          
          // Update the transcript in state
          setTranscripts(prev => prev.map(t => t.id === conversation.id ? updatedTranscript : t));
          setFilteredTranscripts(prev => prev.map(t => t.id === conversation.id ? updatedTranscript : t));
          
          console.log('Hardware recording saved with AI title:', result.title);
        } else {
          console.error('Failed to get AI title from backend:', response.statusText);
          // Update with fallback title
          const fallbackTranscript = { ...tempTranscript, title: 'Hardware Recording', aiTitle: 'Hardware Recording' };
          setTranscripts(prev => prev.map(t => t.id === conversation.id ? fallbackTranscript : t));
          setFilteredTranscripts(prev => prev.map(t => t.id === conversation.id ? fallbackTranscript : t));
        }
      } catch (error) {
        console.error('Failed to save hardware recording to backend:', error);
        // Update with fallback title
        const fallbackTranscript = { ...tempTranscript, title: 'Hardware Recording', aiTitle: 'Hardware Recording' };
        setTranscripts(prev => prev.map(t => t.id === conversation.id ? fallbackTranscript : t));
        setFilteredTranscripts(prev => prev.map(t => t.id === conversation.id ? fallbackTranscript : t));
      }
    }
    
    // Clear realtime transcripts
    setRealtimeTranscripts([]);
  };

  const toggleRecording = async () => {
    if (isRecording) {
      try {
        setIsLoading(true);
        
        const audioUri = await AudioRecordingService.stopRecording();
        
        if (audioUri) {
          const base64Audio = await AudioRecordingService.getRecordingBase64();
          
          if (base64Audio) {
            const response = await APIService.sendAudioBase64(base64Audio, currentRecordingId, 'm4a');
            
            if (response.transcription) {
              console.log('✅ Transcription received:', response.transcription);
              console.log('🆔 Recording ID:', currentRecordingId);
              console.log('⏰ Recording timestamp:', new Date().toISOString());
              console.log('📝 Response data:', JSON.stringify(response, null, 2));
              
              // Create immediate local transcript to show in UI right away
              const immediateTranscript: Transcript = {
                id: currentRecordingId,
                text: response.transcription,
                title: response.title || 'New Recording',
                summary: response.summary || 'Processing...',
                timestamp: new Date(),
                aiTitle: response.title || 'Processing AI title...',
                aiSummary: response.summary || 'Generating AI summary...',
                source: 'recording',
                path: response.recordingId || currentRecordingId,
              };
              
              console.log('📱 Adding immediate transcript to local state:', immediateTranscript.id);
              
              // Add to front of transcript list immediately
              const updatedTranscripts = [immediateTranscript, ...transcripts];
              setTranscripts(updatedTranscripts);
              setFilteredTranscripts(updatedTranscripts);
              
              // CRITICAL: Save to local storage immediately so it persists on app refresh
              await TranscriptStorageService.saveTranscripts(updatedTranscripts);
              console.log(`💾 Saved immediate transcript to local storage for persistence`);
              
              console.log(`✅ Local transcript added - now showing ${updatedTranscripts.length} total transcripts`);
              
              // Still refresh from backend but don't let it override our local transcript
              setTimeout(() => {
                console.log('🔄 About to refresh transcripts from backend...');
                console.log('🔍 Looking for recording ID in backend:', currentRecordingId);
                loadTranscriptsFromBackend();
              }, 4000); // Increased delay to 4 seconds
            }
          }
        }
      } catch (error) {
        console.error('Failed to stop recording:', error);
        Alert.alert('Error', 'Failed to process recording');
      } finally {
        setIsLoading(false);
        setIsRecording(false);
        setCurrentRecordingId('');
      }
    } else {
      try {
        const recordingId = uuid.v4() as string;
        setCurrentRecordingId(recordingId);
        
        await AudioRecordingService.startRecording();
        setIsRecording(true);
        console.log('Audio recording started');
      } catch (error) {
        console.error('Failed to start recording:', error);
        Alert.alert('Recording Error', 'Failed to start recording. Please check microphone permissions.');
        setIsRecording(false);
      }
    }
  };

  const toggleExpand = (id: string) => {
    setTranscripts(prev => prev.map(t => 
      t.id === id ? { ...t, isExpanded: !t.isExpanded } : t
    ));
  };

  const deleteTranscript = async (transcript: Transcript) => {
    Alert.alert(
      'Delete this item?',
      'This will remove it from the list and from ZeroEntropy.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              // Delete from ZeroEntropy only if we have a real document path
              if (transcript.path) {
                await APIService.deleteDocument(transcript.path);
                console.log(`Successfully deleted transcript with path ${transcript.path}`);
              } else {
                console.log('No path found, removing locally only');
              }
              
              // Remove from UI
              setTranscripts((prev) => prev.filter((t) => t.id !== transcript.id));
            } catch (err) {
              console.error('Delete failed:', err);
              Alert.alert('Delete Failed', 'Could not delete the document.');
              // Reload in case of error
              loadTranscriptsFromBackend();
            }
          }
        }
      ]
    );
  };

  const handleUploadAudio = async () => {
    try {
      setIsUploadingAudio(true);
      const pick = await DocumentPicker.getDocumentAsync({
        type: ['audio/wav', 'audio/x-m4a', 'audio/m4a', 'audio/mp4', 'audio/*'],
        multiple: false,
        copyToCacheDirectory: true,
      });
      
      if (pick.canceled || !pick.assets || pick.assets.length === 0) {
        return;
      }
      
      const asset = pick.assets[0];
      const uri = asset.uri;
      const filename = asset.name || `upload-${Date.now()}.audio`;
      
      // Detect format from filename or mime type
      let format = 'wav';
      if (filename.toLowerCase().endsWith('.m4a') || asset.mimeType?.includes('m4a')) {
        format = 'm4a';
      } else if (filename.toLowerCase().endsWith('.mp3') || asset.mimeType?.includes('mp3')) {
        format = 'mp3';
      }
      
      console.log(`Uploading audio file: ${filename}, format: ${format}, type: ${asset.mimeType}`);

      // Read the file as base64
      const base64Audio = await FileSystem.readAsStringAsync(uri, { 
        encoding: FileSystem.EncodingType.Base64 
      });
      
      // Send to backend for transcription and storage
      const recordingId = uuid.v4() as string;
      const response = await APIService.sendAudioBase64(base64Audio, recordingId, format);
      
      if (response.transcription) {
        Alert.alert('Success', `Transcribed and uploaded ${filename} to ZeroEntropy`);
        console.log('Transcription:', response.transcription);
        // Reload transcripts to show the new one
        setTimeout(loadTranscriptsFromBackend, 2000);
      }
    } catch (e: any) {
      console.error('Audio upload failed:', e);
      Alert.alert('Upload Failed', e?.message || 'Unknown error');
    } finally {
      setIsUploadingAudio(false);
    }
  };

  const handleUploadText = async () => {
    try {
      setIsUploading(true);
      const pick = await DocumentPicker.getDocumentAsync({
        type: ['text/plain', 'text/*', 'application/text', '*/*'], // More flexible type matching
        multiple: false,
        copyToCacheDirectory: true,
      });
      
      if (pick.canceled || !pick.assets || pick.assets.length === 0) {
        return;
      }
      
      const asset = pick.assets[0];
      const uri = asset.uri;
      const filename = asset.name || `upload-${Date.now()}.txt`;
      
      console.log('Picked file:', filename, 'URI:', uri, 'Type:', asset.mimeType);

      const fileContent = await FileSystem.readAsStringAsync(uri, { 
        encoding: FileSystem.EncodingType.UTF8 
      });
      
      console.log('File content length:', fileContent.length);
      console.log('First 200 chars:', fileContent.substring(0, 200));
      
      if (!fileContent || fileContent.trim().length === 0) {
        Alert.alert('Error', 'File appears to be empty');
        return;
      }
      
      const result = await APIService.uploadTextDocument(fileContent, {
        path: `mobile/uploads/${filename}`,
        metadata: { source: 'mobile', filename },
        collectionName: 'ai-wearable-transcripts',
      });
      
      Alert.alert('Success', `Uploaded ${filename} to ZeroEntropy\n${fileContent.length} characters`);
      console.log('Upload result:', result);
      
      // Reload transcripts after a delay to ensure it's processed
      setTimeout(loadTranscriptsFromBackend, 2000);
    } catch (e: any) {
      console.error('Upload failed:', e);
      Alert.alert('Upload Failed', e?.message || 'Unknown error');
    } finally {
      setIsUploading(false);
    }
  };

  // BLE Functions
  const scanForDevices = async () => {
    try {
      setIsScanning(true);
      console.log('Starting scan for XIAO-REC devices...');
      
      const devices = await BLEFileTransferService.scanForDevices(10000);
      setAvailableDevices(devices);
      
      if (devices.length === 0) {
        Alert.alert('No devices found', 'Make sure your XIAO device finished recording and is advertising (switch is in LOW position)');
      } else if (devices.length === 1) {
        // Auto-select if only one device
        setSelectedDevice(devices[0]);
        console.log(`Auto-selected device: ${devices[0].name}`);
      }
      
      console.log(`Found ${devices.length} XIAO-REC devices`);
    } catch (error) {
      console.error('Device scan failed:', error);
      Alert.alert('Scan Failed', 'Failed to scan for devices. Make sure Bluetooth is enabled.');
    } finally {
      setIsScanning(false);
    }
  };

  const autoSyncFromDevice = async () => {
    try {
      setIsScanning(true);
      setIsSyncing(false);
      setSyncProgress(0);
      console.log('Auto-sync: Starting scan for XIAO devices...');
      
      // Scan for devices
      const devices = await BLEFileTransferService.scanForDevices(10000); // 10 second scan
      setAvailableDevices(devices);
      
      if (devices.length === 0) {
        Alert.alert(
          'No XIAO Device Found', 
          'Make sure your XIAO device finished recording and switch is in LOW position to start advertising.'
        );
        return;
      }
      
      // Auto-select first XIAO device found
      const xiaoDevice = devices[0];
      setSelectedDevice(xiaoDevice);
      console.log(`Auto-sync: Found ${devices.length} devices, connecting to: ${xiaoDevice.name} (${xiaoDevice.id})`);
      
      // Immediately start syncing
      setIsScanning(false);
      setIsSyncing(true);
      
      await performSync(xiaoDevice);
      
    } catch (error) {
      console.error('Auto-sync failed:', error);
      Alert.alert('Auto-Sync Failed', `Failed to sync: ${error.message}`);
    } finally {
      setIsScanning(false);
      setIsSyncing(false);
      setSyncProgress(0);
    }
  };

  const performSync = async (device: any) => {
    console.log(`Syncing from device: ${device.name} (${device.id})`);
    
    // Connect to device
    const connected = await BLEFileTransferService.connect(device);
    if (!connected) {
      Alert.alert('Connection Failed', 'Could not connect to device. Make sure it is in range and advertising.');
      return;
    }
    
    console.log('Connected to device, reading file info...');
    
    try {
      // Download and process audio file (handles ADPCM/WAV automatically)
      const result = await BLEFileTransferService.downloadAndProcessAudioFile((percent) => {
        setSyncProgress(percent);
      });
      
      if (!result) {
        Alert.alert('Download Failed', 'Could not download or process audio file from device.');
        return;
      }
      
      const { audioData, format, fileInfo, audioInfo } = result;
      
      console.log(`🎵 Downloaded and processed ${fileInfo.name}:`);
      console.log(`   - Format: ${format}`);
      console.log(`   - Original size: ${audioInfo.originalSize} bytes`);
      console.log(`   - Processed size: ${audioInfo.processedSize} bytes`);
      console.log(`   - Duration: ${audioInfo.duration.toFixed(1)}s`);
      if (format === 'ADPCM') {
        console.log(`   - Compression ratio: ${(audioInfo.originalSize / audioInfo.processedSize * 100).toFixed(1)}%`);
      }
      
      // Validate processed audio file size
      if (audioData.length < 1000) {
        Alert.alert('Transfer Incomplete', `Audio file too small: ${audioData.length} bytes. Expected at least 10KB for audio recording.`);
        console.warn(`Audio transfer may be incomplete: ${audioData.length} bytes`);
      } else {
        console.log(`Audio file size looks good: ${(audioData.length / 1024).toFixed(1)} KB`);
      }
      
      // Create organized storage structure
      const now = new Date();
      const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const recordingsDir = `${FileSystem.documentDirectory}recordings/`;
      const monthDir = `${recordingsDir}${yearMonth}/`;
      
      // Ensure directories exist
      const recordingsDirInfo = await FileSystem.getInfoAsync(recordingsDir);
      if (!recordingsDirInfo.exists) {
        await FileSystem.makeDirectoryAsync(recordingsDir, { intermediates: true });
      }
      
      const monthDirInfo = await FileSystem.getInfoAsync(monthDir);
      if (!monthDirInfo.exists) {
        await FileSystem.makeDirectoryAsync(monthDir, { intermediates: true });
      }
      
      // Generate unique filename
      const timestamp = now.toISOString().replace(/[:.]/g, '-');
      const recordingId = uuid.v4() as string;
      const fileName = fileInfo.name || `XIAO_${timestamp}.wav`;
      const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const wavPath = `${monthDir}${recordingId}_${sanitizedFileName}`;
      
      // Save processed audio file to organized location
      await FileSystem.writeAsStringAsync(
        wavPath,
        Buffer.from(audioData).toString('base64'),
        { encoding: FileSystem.EncodingType.Base64 }
      );
      
      console.log(`Audio file saved to: ${wavPath}`);
      
      // Process through transcription pipeline
      const formData = new FormData();
      formData.append('audio', {
        uri: wavPath,
        name: sanitizedFileName,
        type: 'audio/wav'
      } as any);
      formData.append('recordingId', recordingId);
      
      console.log('Starting transcription...');
      const transcriptionResult = await APIService.transcribeAudio(formData);
      
      // Add to transcripts list with local audio path
      const newTranscript: Transcript = {
        id: recordingId,
        text: transcriptionResult.text || '[No speech detected]',
        timestamp: new Date(),
        title: transcriptionResult.aiTitle,
        summary: transcriptionResult.aiSummary,
        aiTitle: transcriptionResult.aiTitle,
        aiSummary: transcriptionResult.aiSummary,
        durationSeconds: transcriptionResult.durationSeconds,
        path: transcriptionResult.path,
        localAudioPath: wavPath, // Store local WAV path
        remoteAudioUrl: transcriptionResult.audioUrl, // Store remote URL if provided
        source: 'ble', // Mark as BLE source
      };
      
      setTranscripts(prev => [newTranscript, ...prev]);
      
      // Also update filtered transcripts if search is active
      if (searchQuery) {
        setFilteredTranscripts(prev => [newTranscript, ...prev]);
      }
      
      Alert.alert('Success', `File synced and transcribed successfully!\n\n${sanitizedFileName}\n${format} format, ${audioData.length} bytes`);
      
      // Clear selection after successful sync
      setSelectedDevice(null);
      setAvailableDevices([]);
      
      // Refresh from backend after a short delay to get complete metadata
      setTimeout(() => {
        console.log('Refreshing transcripts from backend after BLE sync...');
        loadTranscriptsFromBackend();
      }, 3000);
      
    } catch (error) {
      console.error('Sync failed:', error);
      Alert.alert('Sync Failed', `Failed to sync from device: ${error.message}`);
    } finally {
      setIsSyncing(false);
      setSyncProgress(0);
      // Always disconnect when done
      try {
        await BLEFileTransferService.disconnect();
      } catch (e) {
        console.error('Disconnect error:', e);
      }
    }
  };

  // Auto-scan functions
  const loadAutoScanPreference = async () => {
    try {
      const storedValue = await SecureStorageService.getItemAsync(AUTO_SCAN_STORAGE_KEY);
      if (storedValue !== null) {
        const enabled = JSON.parse(storedValue);
        setAutoScanEnabled(enabled);
        console.log('Loaded auto-scan preference:', enabled);
      }
    } catch (error) {
      console.error('Failed to load auto-scan preference:', error);
    }
  };

  const saveAutoScanPreference = async (enabled: boolean) => {
    try {
      await SecureStorageService.setItemAsync(AUTO_SCAN_STORAGE_KEY, JSON.stringify(enabled));
      console.log('Saved auto-scan preference:', enabled);
    } catch (error) {
      console.error('Failed to save auto-scan preference:', error);
    }
  };

  const toggleAutoScan = async (enabled: boolean) => {
    setAutoScanEnabled(enabled);
    await saveAutoScanPreference(enabled);
    
    if (enabled && appState === 'active') {
      console.log('Auto-scan enabled, starting...');
      startAutoScan();
    } else {
      console.log('Auto-scan disabled, stopping...');
      stopAutoScan();
    }
  };

  const startAutoScan = () => {
    if (autoScanInterval || isScanning || isSyncing) {
      console.log('Auto-scan already running or manual operations in progress');
      return;
    }

    console.log('Starting auto-scan with', AUTO_SCAN_INTERVAL_MS / 1000, 'second intervals');
    
    // Run initial scan immediately
    performAutoScan();
    
    // Set up recurring scans
    const interval = setInterval(() => {
      performAutoScan();
    }, AUTO_SCAN_INTERVAL_MS);
    
    setAutoScanInterval(interval);
  };

  const stopAutoScan = () => {
    if (autoScanInterval) {
      console.log('Stopping auto-scan interval');
      clearInterval(autoScanInterval);
      setAutoScanInterval(null);
    }
    setIsAutoScanning(false);
  };

  const performAutoScan = async () => {
    // Don't auto-scan if manual operations are in progress
    if (isScanning || isSyncing || isRecording) {
      return;
    }

    // Don't auto-scan if app is not in foreground
    if (appState !== 'active') {
      return;
    }

    try {
      setIsAutoScanning(true);
      setLastAutoScanTime(new Date());
      
      // Scan with shorter timeout for battery efficiency
      const devices = await BLEFileTransferService.scanForDevices(AUTO_SCAN_TIMEOUT_MS);
      
      if (devices.length > 0) {
        // Only log when XIAO devices are found
        console.log(`🎙️ XIAO Device Found: ${devices[0].name} - Starting automatic sync...`);
        
        // Auto-connect to first device found
        const xiaoDevice = devices[0];
        setSelectedDevice(xiaoDevice);
        setAvailableDevices(devices);
        
        // Stop auto-scanning and start sync
        stopAutoScan();
        setIsAutoScanning(false);
        
        // Auto-sync without showing popup
        performSyncFromAutoScan(xiaoDevice);
      }
    } catch (error) {
      console.error('Auto-scan failed:', error);
    } finally {
      setIsAutoScanning(false);
    }
  };

  const performSyncFromAutoScan = async (device: any) => {
    try {
      setIsSyncing(true);
      await performSync(device);
      
      // Clear device selection after sync
      setSelectedDevice(null);
      setAvailableDevices([]);
      
      // Resume auto-scanning after successful sync (with delay)
      if (autoScanEnabled && appState === 'active') {
        setTimeout(() => {
          console.log('Resuming auto-scan after successful sync');
          startAutoScan();
        }, 10000); // Wait 10 seconds before resuming
      }
    } catch (error) {
      console.error('Auto-sync failed:', error);
      Alert.alert('Auto-Sync Failed', `Failed to sync: ${error.message}`);
      
      // Resume auto-scanning after failed sync
      if (autoScanEnabled && appState === 'active') {
        setTimeout(() => {
          console.log('Resuming auto-scan after failed sync');
          startAutoScan();
        }, 5000); // Wait 5 seconds before resuming
      }
    } finally {
      setIsSyncing(false);
    }
  };

  const openReport = async (t: Transcript) => {
    try {
      const dt = t.timestamp;
      const dateStr = dt.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      const timeStr = dt.toLocaleTimeString();
      const durationStr = formatDuration(t.durationSeconds ?? t.duration_seconds);
      let summary = '';
      try {
        summary = await APIService.generateSummary(t.text);
      } catch {
        summary = 'The recording did not contain any speech or detectable audio content.';
      }
      setReportContent({
        title: 'Taya Transcription Report',
        date: dateStr,
        time: timeStr,
        duration: durationStr,
        summary,
        transcription: t.text && t.text.trim().length > 0 ? t.text : '[No speech detected]',
      });
      setReportVisible(true);
    } catch (e) {
      console.error('Failed to open report:', e);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient
        colors={[colors.background.primary, colors.background.secondary]}
        style={styles.gradient}
      >
        <View style={styles.header}>
          <Text style={styles.title}>Welcome to Taya</Text>
         
        </View>

        <View style={styles.recordContainer}>
          {/* Main Recording Section - Horizontal Layout */}
          <View style={styles.recordingRow}>
            {/* Device Sync Button - Small Circular */}
            <TouchableOpacity
              style={styles.miniCircularButton}
              onPress={autoSyncFromDevice}
              disabled={isScanning || isSyncing}
            >
              <LinearGradient
                colors={[colors.primary.main, colors.primary.dark]}
                style={styles.miniButtonGradient}
              >
                {isScanning || isSyncing ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Ionicons name="bluetooth" size={12} color="#fff" />
                )}
              </LinearGradient>
            </TouchableOpacity>

            {/* Main Record Button */}
            <TouchableOpacity
              style={styles.recordButtonWrapper}
              onPress={toggleRecording}
              disabled={isLoading}
            >
              <Animated.View
                style={[
                  styles.pulseCircle,
                  {
                    transform: [{ scale: pulseAnim }],
                    opacity: isRecording ? 0.3 : 0,
                  },
                ]}
              />
              <LinearGradient
                colors={
                  isRecording 
                    ? [colors.accent.error, '#DC2626']
                    : [colors.primary.main, colors.secondary.main]
                }
                style={styles.recordButton}
              >
                {isLoading ? (
                  <ActivityIndicator color="#fff" size="large" />
                ) : (
                  <Ionicons 
                    name={isRecording ? 'stop' : 'mic'} 
                    size={24} 
                    color="#fff" 
                  />
                )}
              </LinearGradient>
            </TouchableOpacity>

            {/* Upload Button - Small Circular */}
            <TouchableOpacity
              style={styles.miniCircularButton}
              onPress={() => setShowUploadOptions(!showUploadOptions)}
            >
              <LinearGradient
                colors={[colors.primary.light, colors.primary.main]}
                style={styles.miniButtonGradient}
              >
                <Ionicons name="cloud-upload" size={12} color="#fff" />
              </LinearGradient>
            </TouchableOpacity>
          </View>
          
          <Text style={styles.recordHint}>
            {isRecording ? 'Tap to stop' : 'Tap to record'}
          </Text>
        </View>
        {isWebhookMonitoring && (
            <View style={styles.realtimeSection}>
              <TouchableOpacity 
                style={styles.realtimeHeader} 
                onPress={() => setIsTranscriptionCollapsed(!isTranscriptionCollapsed)}
              >
                <Ionicons name="radio" size={16} color={isHardwareRecording ? colors.text.accent : colors.primary.main} />
                <Text style={styles.realtimeSectionTitle}>
                  {isHardwareRecording ? 'Recording' : 'Listening'} 
                </Text>
                <View style={styles.statusIndicator}>
                  <ActivityIndicator size="small" color={colors.primary.main} />
                  <Text style={styles.statusText}>LIVE</Text>
                </View>
                <Ionicons 
                  name={isTranscriptionCollapsed ? 'chevron-down' : 'chevron-up'} 
                  size={16} 
                  color={colors.text.secondary} 
                  style={{ marginLeft: 8 }}
                />
              </TouchableOpacity>
              
              {!isTranscriptionCollapsed && (
                realtimeTranscripts.length > 0 ? (
                  <ScrollView style={styles.transcriptContainer} nestedScrollEnabled>
                    {realtimeTranscripts.slice(-10).map((segment, index) => {
                      // Create a unique key using multiple properties to prevent duplicates
                      const uniqueKey = `${segment.conversationId || 'webhook'}-${index}-${segment.receivedAt?.getTime() || Date.now()}-${segment.text?.slice(0, 20).replace(/\s/g, '')}`;
                      return (
                        <View key={uniqueKey} style={styles.transcriptSegment}>
                          <View style={styles.transcriptHeader}>
                            <Text style={styles.transcriptTime}>
                              {segment.receivedAt ? segment.receivedAt.toLocaleTimeString() : 'Now'}
                            </Text>
                            {segment.speaker && (
                              <Text style={styles.transcriptSpeaker}>{segment.speaker}</Text>
                            )}
                            {segment.confidence && (
                              <Text style={styles.transcriptConfidence}>
                                {Math.round(segment.confidence * 100)}%
                              </Text>
                            )}
                          </View>
                          <Text style={styles.transcriptText}>{segment.text}</Text>
                        </View>
                      );
                    })}
                    {realtimeTranscripts.length > 10 && (
                      <Text style={styles.realtimeMore}>
                        +{realtimeTranscripts.length - 10} earlier transcripts...
                      </Text>
                    )}
                  </ScrollView>
                ) : (
                  <View style={styles.emptyTranscriptState}>
                    <Text style={styles.emptyTranscriptText}>
                      Waiting for transcription data from webhook...
                    </Text>
                    <Text style={styles.emptyTranscriptSubtext}>
                      Send audio to trigger hardware transcription
                    </Text>
                  </View>
                )
              )}
            </View>
          )}
        <View style={styles.transcriptsSection}>
          <View style={styles.transcriptsHeader}>
            <Text style={styles.sectionTitle}>Recent Transcripts</Text>
            <View style={styles.headerControls}>
              <TouchableOpacity
                style={styles.refreshButton}
                onPress={loadTranscriptsFromBackend}
              >
                <Ionicons name="refresh" size={18} color={colors.primary.main} />
              </TouchableOpacity>
            </View>
          </View>

          {/* Search Bar */}
          <View style={styles.searchContainer}>
            <View style={styles.searchInputWrapper}>
              <Ionicons name="search" size={18} color={colors.text.secondary} />
              <TextInput
                style={styles.searchInput}
                placeholder="Search transcripts..."
                placeholderTextColor={colors.text.disabled}
                value={searchQuery}
                onChangeText={setSearchQuery}
              />
              {searchQuery.length > 0 && (
                <TouchableOpacity onPress={() => setSearchQuery('')}>
                  <Ionicons name="close-circle" size={18} color={colors.text.secondary} />
                </TouchableOpacity>
              )}
            </View>
            {searchQuery && filteredTranscripts.length > 0 && (
              <Text style={styles.searchResults}>
                Found {filteredTranscripts.length} result{filteredTranscripts.length !== 1 ? 's' : ''}
              </Text>
            )}
          </View>

          {/* Webhook Transcription Monitor */}
         


          <ScrollView 
            ref={scrollViewRef}
            style={styles.transcriptsList}
            showsVerticalScrollIndicator={false}
          >
            {filteredTranscripts.length === 0 ? (
              <View style={styles.emptyState}>
                <Ionicons 
                  name={searchQuery ? "search-outline" : "mic-off-outline"} 
                  size={40} 
                  color={colors.text.secondary} 
                />
                <Text style={styles.emptyText}>
                  {searchQuery ? 'No matching transcripts' : 'No recordings yet'}
                </Text>
                <Text style={styles.emptySubtext}>
                  {searchQuery ? 'Try different search terms' : 'Tap the mic to start recording'}
                </Text>
              </View>
            ) : (
              filteredTranscripts.map((transcript) => (
                <TouchableOpacity 
                  key={transcript.id} 
                  style={[
                    styles.transcriptCard,
                    highlightedId === transcript.id && styles.highlightedCard
                  ]}
                  onPress={() => {
                    const transcriptionData = {
                      id: transcript.id,
                      text: transcript.text,
                      timestamp: transcript.timestamp.toISOString(),
                      recordingId: transcript.recordingId,
                      aiTitle: transcript.aiTitle || `Transcription ${transcript.recordingId}`,
                      aiSummary: transcript.aiSummary || '',
                      topic: transcript.topic || '',
                    };
                    navigation.navigate('TranscriptionDetail', { transcription: transcriptionData });
                  }}
                  activeOpacity={0.7}
                >
                  <LinearGradient
                    colors={
                      highlightedId === transcript.id 
                        ? [`${colors.primary.main}20`, `${colors.secondary.main}15`]
                        : [`${colors.primary.main}10`, `${colors.secondary.main}05`]
                    }
                    style={styles.cardGradient}
                  >
                    <View style={styles.cardHeader}>
                      <View style={styles.cardHeaderLeft}>
                        <View style={styles.titleContainer}>
                          <Text style={styles.transcriptTitle}>
                            {transcript.aiTitle || transcript.title || 'Untitled Recording'}
                          </Text>
                          <Text style={styles.transcriptTime}>
                            {transcript.timestamp.toLocaleString()}
                          </Text>
                        </View>
                      </View>
                      <View style={styles.actionsContainer}>
                        {/* Primary Chat Action */}
                        <TouchableOpacity
                          style={styles.primaryChatButton}
                          onPress={(e) => {
                            e.stopPropagation();
                            const transcriptionData = {
                              id: transcript.id,
                              text: transcript.text,
                              timestamp: transcript.timestamp.toISOString(),
                              recordingId: transcript.recordingId,
                              aiTitle: transcript.aiTitle || `Transcription ${transcript.recordingId}`,
                              aiSummary: transcript.aiSummary || '',
                              topic: transcript.topic || '',
                            };
                            navigation.navigate('TranscriptionDetail', { 
                              transcription: transcriptionData,
                              openChat: true
                            });
                          }}
                          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                        >
                          <LinearGradient
                            colors={[colors.primary.main, colors.secondary.main]}
                            style={styles.primaryChatGradient}
                          >
                            <Ionicons name="chatbubbles" size={20} color="#fff" />
                            <Text style={styles.primaryChatText}>Chat</Text>
                          </LinearGradient>
                        </TouchableOpacity>
                        
                        {/* Secondary Actions */}
                        <View style={styles.secondaryActions}>
                          <TouchableOpacity
                            style={styles.secondaryActionButton}
                            onPress={(e) => {
                              e.stopPropagation();
                              copyReport(transcript);
                            }}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          >
                            <Ionicons name="copy-outline" size={14} color={colors.text.secondary} />
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={styles.secondaryActionButton}
                            onPress={(e) => {
                              e.stopPropagation();
                              deleteTranscript(transcript);
                            }}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          >
                            <Ionicons name="trash-outline" size={14} color={colors.accent.error} />
                          </TouchableOpacity>
                        </View>
                      </View>
                    </View>
                    {/* Show AI title + summary collapsed; full report when expanded */}
                    {transcript.isExpanded ? (
                      <View>
                        <Text style={styles.reportTitleInline}>📄 Taya Transcription Report</Text>
                        <Text style={styles.reportMeta}>📅 Date: {transcript.timestamp.toLocaleDateString()}</Text>
                        <Text style={styles.reportMeta}>🕐 Time: {transcript.timestamp.toLocaleTimeString()}</Text>
                        <Text style={styles.reportMeta}>⏱️ Duration: {formatDuration(transcript.durationSeconds ?? transcript.duration_seconds)}</Text>
                        <Text style={styles.reportSection}>🤖 AI Summary:</Text>
                        <Text style={styles.reportBody}>{transcript.aiSummary || '—'}</Text>
                        <Text style={styles.reportSection}>📝 Full Transcription:</Text>
                        <Text style={styles.reportBody}>{(transcript.text && transcript.text.trim().length > 0) ? transcript.text : '[No speech detected]'}</Text>
                        <Text style={styles.reportFooter}>—{"\n"}Generated by Taya App{"\n"}AI-powered voice companion</Text>
                      </View>
                    ) : (
                      <View>
                        <Text style={styles.aiSummary} numberOfLines={2}>
                          {transcript.aiSummary || 'Summary unavailable'}
                        </Text>
                      </View>
                    )}
                  </LinearGradient>
                </TouchableOpacity>
              ))
            )}
          </ScrollView>
        </View>
      </LinearGradient>

      {/* Upload Options Dropdown - positioned at screen level */}
      {showUploadOptions && (
        <View style={styles.screenDropdownContainer}>
          <TouchableOpacity
            style={styles.dropdownOption}
            onPress={handleUploadText}
            disabled={isUploading}
          >
            <Ionicons name="document-text" size={12} color={colors.primary.main} />
            <Text style={styles.dropdownOptionText}>Text File</Text>
            {isUploading && <ActivityIndicator size="small" color={colors.primary.main} />}
          </TouchableOpacity>

          <View style={styles.dropdownSeparator} />

          <TouchableOpacity
            style={styles.dropdownOption}
            onPress={handleUploadAudio}
            disabled={isUploadingAudio}
          >
            <Ionicons name="musical-notes" size={12} color={colors.primary.main} />
            <Text style={styles.dropdownOptionText}>Audio File</Text>
            {isUploadingAudio && <ActivityIndicator size="small" color={colors.primary.main} />}
          </TouchableOpacity>
        </View>
      )}

      {/* Modal removed; full report shown inline on expand */}
    </SafeAreaView>
  );
}

const createStyles = (colors: any) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background.primary,
  },
  gradient: {
    flex: 1,
  },
  header: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    ...typography.h1,
    color: colors.text.primary,
  },
  statusBadges: {
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: spacing.xs,
  },
  recordingBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.accent.error,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.full,
    ...shadows.button,
    shadowColor: colors.accent.error,
  },
  hardwareRecordingBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.primary.main,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.full,
    ...shadows.button,
    shadowColor: colors.primary.main,
  },
  monitoringBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.text.secondary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.full,
    opacity: 0.7,
  },
  recordingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#fff',
    marginRight: spacing.xs,
  },
  recordingTime: {
    ...typography.micro,
    color: '#fff',
    textTransform: 'none',
  },
  recordingLabel: {
    ...typography.micro,
    color: '#fff',
    fontSize: 8,
    fontWeight: '700',
    marginLeft: spacing.xs,
    opacity: 0.8,
  },
  monitoringText: {
    ...typography.micro,
    color: '#fff',
    fontSize: 9,
    fontWeight: '600',
    marginLeft: spacing.xs,
  },
  backgroundIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
    borderRadius: borderRadius.sm,
    marginLeft: spacing.xs,
    gap: 2,
  },
  backgroundText: {
    ...typography.micro,
    color: '#fff',
    fontSize: 9,
    fontWeight: '600',
  },
  recordContainer: {
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  recordingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  recordButtonWrapper: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pulseCircle: {
    position: 'absolute',
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: colors.accent.error,
  },
  recordButton: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
    shadowColor: colors.primary.main,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
  },
  recordHint: {
    marginTop: spacing.xs,
    ...typography.caption,
    color: colors.text.secondary,
    textAlign: 'center',
  },
  actionButtonsContainer: {
    flexDirection: 'row',
    marginTop: spacing.md,
    marginHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  actionSection: {
    flex: 1,
    backgroundColor: colors.background.card,
    borderRadius: borderRadius.md,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.surface.border,
    position: 'relative',
    justifyContent: 'space-between',
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.xs,
    gap: spacing.xs,
    height: 24, // Fixed height to ensure alignment
  },
  actionButton: {
    borderRadius: borderRadius.md,
    overflow: 'hidden',
    ...shadows.inset,
  },
  actionButtonGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
    paddingVertical: 4,
    gap: 2,
    minHeight: 28,
  },
  actionButtonText: {
    ...typography.caption,
    color: '#fff',
    fontSize: 10,
    fontWeight: '600',
  },
  statusText: {
    ...typography.caption,
    color: colors.text.secondary,
    fontSize: 9,
    textAlign: 'center',
    marginTop: 2,
    fontStyle: 'italic',
  },
  dropdownContainer: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    marginTop: 2,
    backgroundColor: colors.background.primary,
    borderRadius: borderRadius.sm,
    borderWidth: 1,
    borderColor: colors.surface.border,
    ...shadows.card,
    zIndex: 9999,
    elevation: 10,
  },
  screenDropdownContainer: {
    position: 'absolute',
    top: 220, // Positioned below the mini circular upload button
    right: 80, // Aligned with the upload button position
    width: 100,
    backgroundColor: colors.background.primary,
    borderRadius: borderRadius.sm,
    borderWidth: 1,
    borderColor: colors.surface.border,
    ...shadows.card,
    zIndex: 10000,
    elevation: 15,
  },
  dropdownOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    gap: spacing.xs,
  },
  dropdownOptionText: {
    ...typography.caption,
    color: colors.text.primary,
    fontSize: 11,
    flex: 1,
  },
  dropdownSeparator: {
    height: 1,
    backgroundColor: colors.surface.border,
  },
  transcriptsSection: {
    flex: 1,
    paddingHorizontal: spacing.lg,
  },
  transcriptsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  headerControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  autoScanToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.xs,
    backgroundColor: `${colors.background.elevated}80`,
    borderRadius: borderRadius.sm,
  },
  autoScanIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  autoScanSpinner: {
    marginLeft: 2,
  },
  switch: {
    transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }],
  },
  autoScanStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    backgroundColor: `${colors.background.elevated}60`,
    borderRadius: borderRadius.sm,
    marginBottom: spacing.sm,
  },
  autoScanStatusText: {
    ...typography.caption,
    color: colors.text.secondary,
    fontSize: 12,
    fontStyle: 'italic',
  },
  sectionTitle: {
    ...typography.h2,
    color: colors.text.primary,
    marginBottom: spacing.xs,
  },
  deviceUploadTitle: {
    ...typography.caption,
    color: colors.text.primary,
    fontSize: 9,
    fontWeight: '600',
    flex: 1,
  },
  sectionSubtitle: {
    ...typography.caption,
    color: colors.text.secondary,
    marginBottom: spacing.lg,
    textAlign: 'center',
  },
  refreshButton: {
    padding: 8,
    backgroundColor: `${colors.primary.main}20`,
    borderRadius: borderRadius.md,
  },
  searchContainer: {
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
  searchInputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: `${colors.primary.light}15`,
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    fontFamily: 'General Sans',
    color: colors.text.primary,
  },
  searchResults: {
    fontSize: 12,
    fontFamily: 'General Sans',
    color: colors.text.secondary,
    marginTop: spacing.xs,
    marginLeft: spacing.sm,
  },
  realtimeSection: {
    backgroundColor: `${colors.primary.main}08`,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    marginVertical: spacing.sm,
    borderWidth: 1,
    borderColor: `${colors.primary.main}20`,
    marginHorizontal: spacing.lg,
  },
  realtimeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.sm,
    gap: spacing.xs,
  },
  realtimeSectionTitle: {
    ...typography.h3,
    color: colors.primary.main,
    fontSize: 14,
    fontWeight: '600',
    flex: 1,
  },
  statusIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  statusText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.primary.main,
    letterSpacing: 0.5,
  },
  transcriptContainer: {
    maxHeight: 300,
    backgroundColor: colors.background.secondary,
    borderRadius: borderRadius.md,
    padding: spacing.sm,
  },
  transcriptSegment: {
    marginBottom: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: `${colors.text.secondary}20`,
  },
  transcriptHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  transcriptTime: {
    fontSize: 10,
    color: colors.text.secondary,
    fontWeight: '500',
  },
  transcriptSpeaker: {
    fontSize: 10,
    color: colors.primary.main,
    fontWeight: '600',
    backgroundColor: `${colors.primary.main}15`,
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
    borderRadius: borderRadius.xs,
  },
  transcriptConfidence: {
    fontSize: 10,
    color: colors.text.accent,
    fontWeight: '500',
  },
  transcriptText: {
    fontSize: 14,
    color: colors.text.primary,
    lineHeight: 20,
    fontFamily: 'General Sans',
  },
  emptyTranscriptState: {
    padding: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTranscriptText: {
    fontSize: 14,
    color: colors.text.secondary,
    textAlign: 'center',
    marginBottom: spacing.xs,
  },
  emptyTranscriptSubtext: {
    fontSize: 12,
    color: colors.text.secondary,
    textAlign: 'center',
    opacity: 0.7,
  },
  realtimeTranscripts: {
    gap: spacing.sm,
  },
  webhookTestSection: {
    backgroundColor: `${colors.accent.warning}08`,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    marginVertical: spacing.sm,
    borderWidth: 1,
    borderColor: `${colors.accent.warning}30`,
  },
  webhookTestTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.accent.warning,
    marginBottom: spacing.sm,
    textAlign: 'center',
  },
  webhookTestButtons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.xs,
  },
  webhookTestButton: {
    flex: 1,
    backgroundColor: `${colors.accent.warning}15`,
    borderRadius: borderRadius.sm,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: `${colors.accent.warning}30`,
  },
  webhookTestButtonText: {
    fontSize: 10,
    fontWeight: '500',
    color: colors.accent.warning,
    textAlign: 'center',
  },
  realtimeSegment: {
    backgroundColor: colors.background.card,
    padding: spacing.sm,
    borderRadius: borderRadius.md,
    borderLeftWidth: 3,
    borderLeftColor: colors.primary.main,
  },
  realtimeText: {
    ...typography.body,
    color: colors.text.primary,
    fontSize: 13,
    lineHeight: 18,
    marginBottom: spacing.xs,
  },
  realtimeTimestamp: {
    ...typography.caption,
    color: colors.text.secondary,
    fontSize: 10,
  },
  realtimeMore: {
    ...typography.caption,
    color: colors.text.secondary,
    textAlign: 'center',
    fontStyle: 'italic',
    marginTop: spacing.xs,
  },
  transcriptsList: {
    flex: 1,
  },
  transcriptCard: {
    marginBottom: spacing.lg,
    borderRadius: borderRadius.xl,
    overflow: 'hidden',
    ...shadows.card,
  },
  highlightedCard: {
    transform: [{ scale: 1.02 }],
    ...shadows.button,
  },
  cardGradient: {
    padding: 8,
    borderWidth: 1,
    borderColor: colors.surface.border,
    borderRadius: borderRadius.xl,
    backgroundColor: `${colors.primary.light}10`,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  cardHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  deleteButton: {
    padding: spacing.xs,
    borderRadius: borderRadius.sm,
    backgroundColor: `${colors.accent.error}10`,
  },
  iconButton: {
    padding: spacing.xs,
    borderRadius: borderRadius.sm,
    backgroundColor: `${colors.primary.main}10`,
  },
  titleContainer: {
    flex: 1,
    marginLeft: spacing.sm,
  },
  transcriptTitle: {
    ...typography.h3,
    color: colors.text.primary,
    marginBottom: spacing.xs,
  },
  transcriptSummary: {
    ...typography.bodySecondary,
    color: colors.text.secondary,
    marginTop: spacing.sm,
  },
  transcriptText: {
    ...typography.bodySecondary,
    color: colors.text.primary,
    lineHeight: 22,
  },
  aiTitle: {
    ...typography.h3,
    color: colors.text.primary,
    marginBottom: spacing.sm,
  },
  aiSummary: {
    ...typography.bodySecondary,
    color: colors.text.secondary,
  },
  transcriptTime: {
    ...typography.micro,
    color: colors.text.secondary,
    marginLeft: spacing.xs,
    textTransform: 'none',
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: spacing.xl * 2,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: '600',
    fontFamily: 'General Sans',
    color: colors.text.secondary,
    marginTop: spacing.md,
  },
  emptySubtext: {
    ...typography.body,
    color: colors.text.disabled,
    marginTop: spacing.xs,
    fontSize: 14,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  modalContent: {
    width: '100%',
    maxWidth: 600,
    backgroundColor: '#fff',
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
  },
  reportTitle: {
    fontSize: 18,
    fontWeight: '500',
    marginBottom: spacing.sm,
    color: colors.text.primary,
  },
  reportMeta: {
    ...typography.caption,
    color: colors.text.secondary,
    marginBottom: 2,
  },
  reportSection: {
    marginTop: spacing.md,
    fontWeight: '500',
    color: colors.text.primary,
  },
  reportBody: {
    ...typography.body,
    color: colors.text.primary,
    marginTop: 4,
  },
  reportFooter: {
    ...typography.caption,
    color: colors.text.disabled,
    marginTop: spacing.sm,
    textAlign: 'center',
  },
  closeButton: {
    marginTop: spacing.md,
    alignSelf: 'center',
    backgroundColor: colors.primary.main,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.lg,
  },
  closeButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
  reportTitleInline: {
    fontSize: 16,
    fontWeight: '500',
    marginBottom: spacing.xs,
    color: colors.text.primary,
  },

  // New Action Container Styles
  actionsContainer: {
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: spacing.sm,
  },
  primaryChatButton: {
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
    ...shadows.button,
  },
  primaryChatGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.xs,
    minWidth: 80,
  },
  primaryChatText: {
    ...typography.button,
    color: '#fff',
    fontSize: 13,
  },
  secondaryActions: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  secondaryActionButton: {
    padding: spacing.xs,
    borderRadius: borderRadius.sm,
    backgroundColor: `${colors.text.secondary}10`,
  },

  // Mini Circular Button Styles
  miniCircularButton: {
    borderRadius: 16, // Perfect circle for 32x32
    overflow: 'hidden',
    ...shadows.button,
    width: 32,
    height: 32,
  },
  miniButtonGradient: {
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    height: '100%',
  },

}); // End of createStyles function