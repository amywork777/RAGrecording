import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import { AppState, AppStateStatus } from 'react-native';

// Background task helpers removed for Expo Go compatibility

class AudioRecordingService {
  private recording: Audio.Recording | null = null;
  private recordingUri: string | null = null;
  private appStateSubscription: any = null;
  private isBackgroundRecordingActive: boolean = false;

  async initialize() {
    try {
      const { status } = await Audio.requestPermissionsAsync();
      if (status !== 'granted') {
        throw new Error('Audio recording permission not granted');
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true, // Enable background audio
      });

      // Set up app state listener for background recording
      this.setupAppStateListener();
    } catch (error) {
      console.error('Failed to initialize audio:', error);
      throw error;
    }
  }

  private setupAppStateListener() {
    if (this.appStateSubscription) {
      this.appStateSubscription.remove();
    }

    this.appStateSubscription = AppState.addEventListener('change', this.handleAppStateChange.bind(this));
  }

  private async handleAppStateChange(nextAppState: AppStateStatus) {
    console.log('AudioRecordingService: App state changed to:', nextAppState);
    
    if (this.recording) {
      if (nextAppState === 'background' || nextAppState === 'inactive') {
        // App going to background while recording - start background task
        await this.startBackgroundRecording();
      } else if (nextAppState === 'active') {
        // App coming back to foreground - stop background task
        await this.stopBackgroundRecording();
      }
    }
  }

  private async startBackgroundRecording() {
    try {
      if (!this.isBackgroundRecordingActive) {
        // Keep recording alive in background using the audio background mode
        this.isBackgroundRecordingActive = true;
        console.log('AudioRecordingService: Background recording enabled');
      }
    } catch (error) {
      console.error('Failed to start background recording:', error);
    }
  }

  private async stopBackgroundRecording() {
    try {
      if (this.isBackgroundRecordingActive) {
        this.isBackgroundRecordingActive = false;
        console.log('AudioRecordingService: Background recording disabled');
      }
    } catch (error) {
      console.error('Failed to stop background recording:', error);
    }
  }

  async startRecording(): Promise<void> {
    try {
      if (this.recording) {
        await this.stopRecording();
      }

      await this.initialize();

      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );
      
      this.recording = recording;
      console.log('Recording started');
    } catch (error) {
      console.error('Failed to start recording:', error);
      throw error;
    }
  }

  async stopRecording(): Promise<string | null> {
    try {
      if (!this.recording) {
        console.log('No recording in progress');
        return null;
      }

      // Stop background recording if active
      await this.stopBackgroundRecording();

      await this.recording.stopAndUnloadAsync();
      const uri = this.recording.getURI();
      this.recordingUri = uri;
      this.recording = null;

      console.log('Recording stopped, saved to:', uri);
      return uri;
    } catch (error) {
      console.error('Failed to stop recording:', error);
      return null;
    }
  }

  async getRecordingBase64(): Promise<string | null> {
    try {
      if (!this.recordingUri) {
        console.log('No recording URI available');
        return null;
      }

      const base64 = await FileSystem.readAsStringAsync(this.recordingUri, {
        encoding: 'base64',
      });

      return base64;
    } catch (error) {
      console.error('Failed to get recording data:', error);
      return null;
    }
  }

  getRecordingUri(): string | null {
    return this.recordingUri;
  }

  isRecording(): boolean {
    return this.recording !== null;
  }

  // Cleanup method to remove listeners
  cleanup() {
    if (this.appStateSubscription) {
      this.appStateSubscription.remove();
      this.appStateSubscription = null;
    }
  }

  // Get background recording status
  isBackgroundRecording(): boolean {
    return this.isBackgroundRecordingActive;
  }
}

export default new AudioRecordingService();