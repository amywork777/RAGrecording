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
  RefreshControl,
  FlatList,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useIsFocused } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import BLEService from '../services/BLEService';
import APIService from '../services/APIService';
import AudioRecordingService from '../services/AudioRecordingService';
import uuid from 'react-native-uuid';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { colors, spacing, borderRadius, typography } from '../theme/colors';

const { width } = Dimensions.get('window');

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
}

export default function RecordScreen({ route }: any) {
  const [isConnected, setIsConnected] = useState(false);
  const [isBleConnecting, setIsBleConnecting] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [bleCodec, setBleCodec] = useState<number | null>(null);
  const [bleStreaming, setBleStreaming] = useState(false);
  const [lastFrameAt, setLastFrameAt] = useState<number | null>(null);
  const [devicePickerVisible, setDevicePickerVisible] = useState(false);
  const [nearbyDevices, setNearbyDevices] = useState<Array<{ id: string; name: string }>>([]);
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
  const [refreshing, setRefreshing] = useState(false);
  const isFocused = useIsFocused();

  useEffect(() => {
    BLEService.on('deviceConnected', handleDeviceConnected);
    BLEService.on('deviceDisconnected', handleDeviceDisconnected);
    BLEService.on('audioChunk', handleAudioChunk);
    BLEService.on('codecChanged', (c: number) => {
      setBleCodec(c);
      Alert.alert('BLE', `Codec: ${c === 20 ? 'Opus' : c === 10 || c === 11 ? 'μ-law' : 'PCM16'}`);
    });
    BLEService.on('streamStarted', () => setBleStreaming(true));
    BLEService.on('streamStopped', () => setBleStreaming(false));

    loadTranscriptsFromBackend();

    return () => {
      BLEService.removeAllListeners();
      if (intervalId) clearInterval(intervalId);
    };
  }, [currentRecordingId]);

  // Reload when screen becomes focused
  useEffect(() => {
    if (isFocused) {
      loadTranscriptsFromBackend();
    }
  }, [isFocused]);

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

  const loadTranscriptsFromBackend = async () => {
    try {
      const recentTranscripts = await APIService.getRecentTranscripts(500);
      
      if (recentTranscripts && recentTranscripts.length > 0) {
        const formattedTranscripts: Transcript[] = recentTranscripts.map((t: any) => {
          const fallbackTitle = (t.title && t.title.trim().length > 0)
            ? t.title
            : (t.text ? (t.text.split('\n')[0] || t.text).slice(0, 50) : 'Untitled');
          const fallbackSummary = (t.summary && t.summary.trim().length > 0)
            ? t.summary
            : (t.text ? (t.text.slice(0, 160) + (t.text.length > 160 ? '…' : '')) : '');
          return {
            id: t.id,
            text: t.text,
            title: t.title,
            summary: t.summary,
            timestamp: new Date(t.timestamp),
            path: t.path,
            aiTitle: t.aiTitle || fallbackTitle,
            aiSummary: t.aiSummary || fallbackSummary,
            // @ts-ignore
            durationSeconds: t.durationSeconds ?? t.duration_seconds ?? null,
          } as any;
        });
        const sorted = formattedTranscripts.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        setTranscripts(sorted);
        setFilteredTranscripts(sorted);
      }
    } catch (error) {
      console.error('Error loading transcripts:', error);
    }
  };

  // Filter transcripts based on search query
  useEffect(() => {
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
    return `📄 TaiNecklace Transcription Report\n\n📅 Date: ${dateStr}\n🕐 Time: ${timeStr}\n⏱️ Duration: ${durStr}\n\nAI Title \n${title}\n\n🤖 AI Summary:\n${summary}\n\n📝 Full Transcription:\n${fullText}\n\n---\nGenerated by TaiNecklace App\nAI-powered voice companion`;
  };

  const copyReport = async (t: any) => {
    const text = buildReportText(t);
    await Clipboard.setStringAsync(text);
    Alert.alert('Copied', 'Report copied to clipboard');
  };

  const handleDeviceConnected = () => {
    setIsConnected(true);
    try {
      // Start BLE audio stream automatically and assign a recording id for this session
      const recId = uuid.v4() as string;
      setCurrentRecordingId(recId);
      BLEService.startAudioStream();
    } catch (e) {}
    Alert.alert('Connected', 'Successfully connected to Omi');
  };

  const handleDeviceDisconnected = () => {
    setIsConnected(false);
    try { BLEService.stopAudioStream(); } catch {}
    setIsRecording(false);
    setCurrentRecordingId('');
    Alert.alert('Disconnected', 'Disconnected from Omi');
  };

  const handleAudioChunk = async (chunk: { base64Wav: string; sampleRate?: number; codec?: number }) => {
    setLastFrameAt(Date.now());
    if (!currentRecordingId) return;
    try {
      const response = await APIService.sendAudioBase64(chunk.base64Wav, currentRecordingId, 'wav');
      if (response.transcription) {
        const newTranscript: Transcript = {
          id: uuid.v4() as string,
          text: response.transcription,
          title: response.title,
          summary: response.summary,
          timestamp: new Date(response.timestamp),
        } as any;
        setTranscripts(prev => [newTranscript, ...prev]);
        setFilteredTranscripts(prev => [newTranscript, ...prev]);
        setTimeout(loadTranscriptsFromBackend, 1500);
      }
    } catch (error) {
      console.error('Error processing BLE audio chunk:', error);
    }
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
              console.log('Transcription received:', response.transcription);
              // Immediately add to UI for fast feedback
              const immediateTranscript: Transcript = {
                id: currentRecordingId,
                text: response.transcription,
                title: response.title || 'New Recording',
                summary: response.summary || 'Processing...'
                  ,
                timestamp: new Date(),
                aiTitle: response.title || 'New Recording',
                aiSummary: response.summary || 'Processing...'
              } as any;

              setTranscripts(prev => [immediateTranscript, ...prev]);
              setFilteredTranscripts(prev => [immediateTranscript, ...prev]);

              // Fetch exact document by path to ensure persistence is reflected
              if ((response as any)?.path) {
                try {
                  const doc = await APIService.getDocumentByPath((response as any).path);
                  const mapped: Transcript = {
                    id: doc.id,
                    text: doc.text,
                    title: doc.title,
                    summary: doc.summary,
                    timestamp: new Date(doc.timestamp),
                    path: doc.path,
                    aiTitle: doc.aiTitle || doc.title,
                    aiSummary: doc.aiSummary || doc.summary,
                    // @ts-ignore
                    durationSeconds: doc.durationSeconds ?? doc.duration_seconds ?? null,
                  } as any;
                  setTranscripts(prev => {
                    const without = prev.filter(t => t.id !== currentRecordingId);
                    return [mapped, ...without];
                  });
                  setFilteredTranscripts(prev => {
                    const without = prev.filter(t => t.id !== currentRecordingId);
                    return [mapped, ...without];
                  });
                } catch (e) {
                  console.warn('Fetch by path failed, will fallback to list refresh:', (e as any)?.message);
                  setTimeout(loadTranscriptsFromBackend, 2000);
                }
              } else {
                // Refresh from backend shortly after to fetch persisted metadata
                setTimeout(loadTranscriptsFromBackend, 2000);
              }
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
        encoding: 'base64' as any
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
        title: 'TaiNecklace Transcription Report',
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
          <Text style={styles.title}>Welcome to Tai</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {/* BLE status pill */}
            <View style={[styles.bleStatus, { backgroundColor: isConnected ? `${colors.primary.main}20` : `${colors.text.secondary}20` }] }>
              <Ionicons name={isConnected ? 'bluetooth' : 'bluetooth-outline'} size={12} color={isConnected ? colors.primary.main : colors.text.secondary} />
              <Text style={[styles.bleStatusText, { color: isConnected ? colors.primary.main : colors.text.secondary }]}>
                {isBleConnecting ? 'Connecting…' : isConnected ? (bleStreaming ? 'Streaming' : 'Connected') : 'Disconnected'}
              </Text>
              {isConnected && bleCodec != null && (
                <Text style={[styles.bleStatusText, { color: isConnected ? colors.primary.main : colors.text.secondary }]}>
                  · {bleCodec === 20 ? 'Opus' : (bleCodec === 10 || bleCodec === 11) ? 'μ-law' : 'PCM16'}
                </Text>
              )}
            </View>
            <TouchableOpacity
              style={[styles.iconButton, { marginRight: spacing.xs }]}
              onPress={async () => {
                try {
                  if (isConnected) {
                    await BLEService.disconnectDevice();
                    return;
                  }
                  setIsBleConnecting(true);
                  const list = await BLEService.scanForDevices();
                  setNearbyDevices(list);
                  setDevicePickerVisible(true);
                } catch (e: any) {
                  Alert.alert('Bluetooth', e?.message || 'Failed to connect. Make sure the device is on and nearby.');
                } finally {
                  setIsBleConnecting(false);
                }
              }}
            >
              {isBleConnecting ? (
                <ActivityIndicator size="small" color={colors.primary.main} />
              ) : (
                <Ionicons name={isConnected ? 'bluetooth' : 'bluetooth-outline'} size={18} color={isConnected ? colors.primary.main : colors.text.secondary} />
              )}
            </TouchableOpacity>
            {isRecording && (
            <View style={styles.recordingBadge}>
              <View style={styles.recordingDot} />
              <Text style={styles.recordingTime}>{formatTime(recordingTime)}</Text>
            </View>
            )}
          </View>
        </View>

        <View style={styles.recordContainer}>
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
                  size={32} 
                  color="#fff" 
                />
              )}
            </LinearGradient>
          </TouchableOpacity>
          
          <Text style={styles.recordHint}>
            {isRecording ? 'Tap to stop' : 'Tap to record'}
          </Text>

          {/* Upload Buttons Container */}
          <View style={styles.uploadButtonsContainer}>
            {/* Upload Text Button */}
            <TouchableOpacity
              style={styles.uploadButton}
              onPress={handleUploadText}
              disabled={isUploading}
            >
              <LinearGradient
                colors={[colors.secondary.dark, colors.secondary.main]}
                style={styles.uploadGradient}
              >
                {isUploading ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <>
                    <Ionicons name="document-text" size={18} color="#fff" />
                    <Text style={styles.uploadText}>Text File</Text>
                  </>
                )}
              </LinearGradient>
            </TouchableOpacity>

            {/* Upload WAV Button */}
            <TouchableOpacity
              style={styles.uploadButton}
              onPress={handleUploadAudio}
              disabled={isUploadingAudio}
            >
              <LinearGradient
                colors={[colors.primary.dark, colors.primary.main]}
                style={styles.uploadGradient}
              >
                {isUploadingAudio ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <>
                    <Ionicons name="musical-notes" size={18} color="#fff" />
                    <Text style={styles.uploadText}>Audio File</Text>
                  </>
                )}
              </LinearGradient>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.transcriptsSection}>
          <View style={styles.transcriptsHeader}>
            <Text style={styles.sectionTitle}>Recent Transcripts</Text>
            <TouchableOpacity
              style={styles.refreshButton}
              onPress={loadTranscriptsFromBackend}
            >
              <Ionicons name="refresh" size={18} color={colors.primary.main} />
            </TouchableOpacity>
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

          <FlatList
            data={filteredTranscripts}
            keyExtractor={(item) => item.id}
            refreshing={refreshing}
            onRefresh={async () => {
              try { setRefreshing(true); await loadTranscriptsFromBackend(); } finally { setRefreshing(false); }
            }}
            contentContainerStyle={{ paddingBottom: 40 }}
            initialNumToRender={8}
            windowSize={10}
            removeClippedSubviews
            renderItem={({ item: transcript }) => (
              <TouchableOpacity 
                style={[
                  styles.transcriptCard,
                  highlightedId === transcript.id && styles.highlightedCard
                ]}
                onPress={() => toggleExpand(transcript.id)}
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
                      <Ionicons 
                        name={transcript.isExpanded ? "chevron-down" : "chevron-forward"} 
                        size={16} 
                        color={colors.primary.main} 
                      />
                      <View style={styles.titleContainer}>
                        <Text style={styles.transcriptTitle}>
                          {transcript.aiTitle || transcript.title || 'Untitled Recording'}
                        </Text>
                        <Text style={styles.transcriptTime}>
                          {transcript.timestamp.toLocaleString()}
                        </Text>
                      </View>
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <TouchableOpacity
                        style={styles.iconButton}
                        onPress={() => copyReport(transcript)}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      >
                        <Ionicons name="copy-outline" size={16} color={colors.primary.main} />
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.deleteButton}
                        onPress={() => deleteTranscript(transcript)}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      >
                        <Ionicons name="trash-outline" size={16} color={colors.accent.error} />
                      </TouchableOpacity>
                    </View>
                  </View>
                  {transcript.isExpanded ? (
                    <View>
                      <Text style={styles.reportTitleInline}>📄 TaiNecklace Transcription Report</Text>
                      <Text style={styles.reportMeta}>📅 Date: {transcript.timestamp.toLocaleDateString()}</Text>
                      <Text style={styles.reportMeta}>🕐 Time: {transcript.timestamp.toLocaleTimeString()}</Text>
                      <Text style={styles.reportMeta}>⏱️ Duration: {formatDuration(transcript.durationSeconds ?? transcript.duration_seconds)}</Text>
                      <Text style={styles.reportSection}>🤖 AI Summary:</Text>
                      <Text style={styles.reportBody}>{transcript.aiSummary || '—'}</Text>
                      <Text style={styles.reportSection}>📝 Full Transcription:</Text>
                      <Text style={styles.reportBody}>{(transcript.text && transcript.text.trim().length > 0) ? transcript.text : '[No speech detected]'}</Text>
                      <Text style={styles.reportFooter}>—{"\n"}Generated by TaiNecklace App{"\n"}AI-powered voice companion</Text>
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
            )}
            ListEmptyComponent={
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
            }
          />
        </View>
      </LinearGradient>

      {/* Device Picker Modal */}
      {devicePickerVisible && (
        <View style={styles.modalBackdrop}>
          <View style={styles.modalContent}>
            <Text style={styles.reportTitle}>Select a device</Text>
            <Text style={styles.reportBody}>Scanning for Omi devices (Friend…, Omi…, DevKit…).</Text>
            <ScrollView style={{ maxHeight: 260 }}>
              {nearbyDevices.length === 0 ? (
                <Text style={styles.reportBody}>No devices found. Make sure your Omi is on and nearby.</Text>
              ) : (
                nearbyDevices.map(d => (
                  <TouchableOpacity
                    key={d.id}
                    style={{ paddingVertical: 10 }}
                    onPress={async () => {
                      try {
                        setDevicePickerVisible(false);
                        setIsBleConnecting(true);
                        await BLEService.connectToDeviceId(d.id);
                      } catch (e: any) {
                        Alert.alert('Bluetooth', e?.message || 'Failed to connect to device.');
                      } finally {
                        setIsBleConnecting(false);
                      }
                    }}
                  >
                    <Text style={styles.reportBody}>{d.name || 'Unknown'}
                      <Text style={{ color: colors.text.disabled }}>  {d.id.slice(0, 6)}…</Text>
                    </Text>
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>
            <TouchableOpacity onPress={() => setDevicePickerVisible(false)} style={styles.closeButton}>
              <Text style={styles.closeButtonText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background.primary,
  },
  gradient: {
    flex: 1,
  },
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.text.primary,
  },
  recordingBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.accent.error,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: borderRadius.full,
  },
  recordingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#fff',
    marginRight: spacing.xs,
  },
  recordingTime: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 13,
  },
  recordContainer: {
    alignItems: 'center',
    paddingVertical: spacing.xl,
  },
  recordButtonWrapper: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pulseCircle: {
    position: 'absolute',
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: colors.accent.error,
  },
  recordButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 8,
    shadowColor: colors.primary.main,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  recordHint: {
    marginTop: spacing.md,
    ...typography.body,
    color: colors.text.secondary,
    fontSize: 14,
  },
  uploadButtonsContainer: {
    flexDirection: 'row',
    marginTop: spacing.xl,
    gap: spacing.md,
    justifyContent: 'center',
  },
  uploadButton: {
    flex: 1,
    maxWidth: 140,
  },
  uploadGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    borderRadius: borderRadius.xl,
    gap: spacing.xs,
  },
  uploadText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 13,
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
  bleStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: borderRadius.full,
  },
  bleStatusText: {
    ...typography.caption,
    fontSize: 12,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: colors.text.primary,
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
    backgroundColor: colors.background.card,
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: colors.text.primary,
  },
  searchResults: {
    fontSize: 12,
    color: colors.text.secondary,
    marginTop: spacing.xs,
    marginLeft: spacing.sm,
  },
  transcriptsList: {
    flex: 1,
  },
  transcriptCard: {
    marginBottom: spacing.sm,
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
  },
  highlightedCard: {
    transform: [{ scale: 1.02 }],
  },
  cardGradient: {
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.surface.border,
    borderRadius: borderRadius.lg,
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
    fontSize: 16,
    fontWeight: '600',
    color: colors.text.primary,
    marginBottom: 2,
  },
  transcriptSummary: {
    fontSize: 14,
    color: colors.text.secondary,
    marginTop: spacing.sm,
    lineHeight: 20,
  },
  transcriptText: {
    ...typography.body,
    color: colors.text.primary,
    fontSize: 14,
    lineHeight: 20,
  },
  aiTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text.primary,
    marginBottom: 4,
  },
  aiSummary: {
    ...typography.body,
    color: colors.text.secondary,
    fontSize: 14,
  },
  transcriptTime: {
    ...typography.caption,
    color: colors.text.secondary,
    fontSize: 12,
    marginLeft: spacing.xs,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: spacing.xl * 2,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: '600',
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
    fontWeight: '700',
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
    fontWeight: '700',
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
    fontWeight: '700',
    marginBottom: spacing.xs,
    color: colors.text.primary,
  },
  reportMeta: {
    ...typography.caption,
    color: colors.text.secondary,
    marginBottom: 2,
  },
  reportSection: {
    marginTop: spacing.sm,
    fontWeight: '700',
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
});