import React, { useState, useEffect } from 'react';
import { CheckCircle2, Circle, Clock, GripVertical } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { taskService } from '@/services/task.service';
import { authService } from '@/services/auth.service';
import type { Task as DBTask, TaskPositionUpdate } from '@/types/task.types';
import {
  DndContext,
  DragOverlay,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragStartEvent,
  DragOverEvent,
  DragEndEvent,
  useDroppable,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface Task {
  id: number;
  title: string;
  duration: string;
  completed: boolean;
  date?: string;
  dbTask: DBTask;
}

interface Column {
  id: string;
  title: string;
  tasks: Task[];
  color: string;
}

// Sortable Task Component
interface SortableTaskProps {
  task: Task;
  index: number;
  columnId: string;
  toggleTaskCompletion: (columnId: string, taskId: number) => void;
}

const SortableTask: React.FC<SortableTaskProps> = ({ task, index, columnId, toggleTaskCompletion }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="bg-secondary/30 dark:bg-muted/50 rounded-lg md:rounded-xl p-3 md:p-4 hover:shadow-md hover:bg-secondary/50 dark:hover:bg-muted transition-all border border-border/50 cursor-grab active:cursor-grabbing"
      {...attributes}
      {...listeners}
    >
      <div className="flex items-start justify-between mb-1 md:mb-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 md:gap-2 mb-1">
            <GripVertical className="w-3 h-3 md:w-4 md:h-4 text-muted-foreground flex-shrink-0" />
            <span className="text-xs md:text-sm font-medium text-muted-foreground flex-shrink-0">
              {index + 1}.
            </span>
            <h3 className={`text-xs md:text-sm font-semibold truncate ${task.completed ? 'line-through text-muted-foreground' : 'text-foreground'}`}>
              {task.title}
            </h3>
          </div>
          <div className="flex items-center gap-1.5 md:gap-2 ml-7 md:ml-9">
            <Clock className="w-2.5 h-2.5 md:w-3 md:h-3 text-muted-foreground flex-shrink-0" />
            <span className="text-xs text-muted-foreground">
              {task.duration}
            </span>
          </div>
          {task.completed && columnId === 'today' && (
            <div className="ml-7 md:ml-9 mt-1">
              <span className="inline-block px-1.5 md:px-2 py-0.5 bg-primary/20 text-primary text-xs rounded font-medium">
                Prep
              </span>
            </div>
          )}
        </div>
        <button 
          onClick={() => toggleTaskCompletion(columnId, task.id)}
          className="p-1 md:p-1.5 hover:bg-accent rounded-full transition-colors flex-shrink-0"
        >
          {task.completed ? (
            <CheckCircle2 className="w-3 h-3 md:w-4 md:h-4 text-primary" />
          ) : (
            <Circle className="w-3 h-3 md:w-4 md:h-4 text-muted-foreground hover:text-foreground" />
          )}
        </button>
      </div>
    </div>
  );
};

// Droppable Column Component
interface DroppableColumnProps {
  column: Column;
  children: React.ReactNode;
}

const DroppableColumn: React.FC<DroppableColumnProps> = ({ column, children }) => {
  const { setNodeRef, isOver } = useDroppable({
    id: column.id,
  });

  return (
    <div
      ref={setNodeRef}
      className={`flex-1 overflow-y-auto space-y-2 md:space-y-3 mb-3 md:mb-4 pr-1 min-h-[200px] rounded-lg transition-colors ${
        isOver ? 'bg-primary/5 border-2 border-primary/30 border-dashed' : ''
      }`}
    >
      {children}
    </div>
  );
};

const TasksPage: React.FC = () => {
  const [columns, setColumns] = useState<Column[]>([
    { id: 'backlog', title: 'Backlog', color: 'gray', tasks: [] },
    { id: 'this_week', title: 'This Week', color: 'blue', tasks: [] },
    { id: 'today', title: 'Today', color: 'blue', tasks: [] },
    { id: 'done', title: 'Done', color: 'green', tasks: [] }
  ]);

  const [newTaskInput, setNewTaskInput] = useState<{ [key: string]: string }>({});
  const [activeId, setActiveId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadTasks();
  }, []);

  const loadTasks = async () => {
    try {
      const user = authService.getUser();
      if (!user) return;

      const dbTasks = await taskService.getTasks(user.id);
      
      // Group tasks by status
      const tasksByStatus: { [key: string]: Task[] } = {
        backlog: [],
        this_week: [],
        today: [],
        done: []
      };

      dbTasks.forEach(dbTask => {
        const task: Task = {
          id: dbTask.id,
          title: dbTask.title,
          duration: dbTask.duration_minutes ? `${dbTask.duration_minutes} Min` : '20 Min',
          completed: !!dbTask.completed_at,
          date: dbTask.completed_at ? new Date(dbTask.completed_at).toLocaleDateString('en-US', { 
            weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' 
          }) : undefined,
          dbTask
        };
        tasksByStatus[dbTask.status]?.push(task);
      });

      setColumns(prev => prev.map(col => ({
        ...col,
        tasks: tasksByStatus[col.id] || []
      })));
    } catch (error) {
      console.error('Failed to load tasks:', error);
    } finally {
      setLoading(false);
    }
  };

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    setActiveId(active.id as number);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;

    const activeId = active.id as number;
    const overId = over.id;

    // Find which column the active task is in
    const activeColumn = columns.find(col => 
      col.tasks.some(task => task.id === activeId)
    );
    
    // Find which column we're over (either by column id or task id)
    let overColumn = columns.find(col => col.id === overId);
    if (!overColumn) {
      overColumn = columns.find(col => 
        col.tasks.some(task => task.id === overId)
      );
    }

    if (!activeColumn || !overColumn) return;
    if (activeColumn.id === overColumn.id) return;

    setColumns(prev => {
      const activeItems = activeColumn.tasks;
      const overItems = overColumn.tasks;

      const activeIndex = activeItems.findIndex(task => task.id === activeId);
      const overIndex = overItems.findIndex(task => task.id === overId);

      let newIndex: number;
      // If dropping on column itself (empty column), add to end
      if (overId === overColumn.id) {
        newIndex = overItems.length;
      } else {
        // If dropping on a task, insert at that position
        const isBelowLastItem = over && overIndex === overItems.length - 1;
        const modifier = isBelowLastItem ? 1 : 0;
        newIndex = overIndex >= 0 ? overIndex + modifier : overItems.length;
      }

      return prev.map(col => {
        if (col.id === activeColumn.id) {
          return {
            ...col,
            tasks: col.tasks.filter(task => task.id !== activeId)
          };
        }
        if (col.id === overColumn.id) {
          const newTasks = [...col.tasks];
          newTasks.splice(newIndex, 0, activeItems[activeIndex]);
          return {
            ...col,
            tasks: newTasks
          };
        }
        return col;
      });
    });
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) {
      setActiveId(null);
      return;
    }

    const activeId = active.id as number;
    const overId = over.id;

    const activeColumn = columns.find(col => 
      col.tasks.some(task => task.id === activeId)
    );

    if (!activeColumn) {
      setActiveId(null);
      return;
    }

    const activeIndex = activeColumn.tasks.findIndex(task => task.id === activeId);
    const overIndex = activeColumn.tasks.findIndex(task => task.id === overId);

    if (activeIndex !== overIndex && activeIndex !== -1 && overIndex !== -1) {
      setColumns(prev => prev.map(col => {
        if (col.id === activeColumn.id) {
          return {
            ...col,
            tasks: arrayMove(col.tasks, activeIndex, overIndex)
          };
        }
        return col;
      }));
    }

    // Save positions to database
    await saveTaskPositions();
    setActiveId(null);
  };

  const saveTaskPositions = async () => {
    try {
      const user = authService.getUser();
      if (!user) return;

      const updates: TaskPositionUpdate[] = [];
      columns.forEach(col => {
        col.tasks.forEach((task, index) => {
          updates.push({
            id: task.id,
            position: index,
            status: col.id
          });
        });
      });

      await taskService.updateTaskPositions(user.id, updates);
    } catch (error) {
      console.error('Failed to save task positions:', error);
    }
  };

  const addTask = async (columnId: string) => {
    const taskTitle = newTaskInput[columnId]?.trim();
    if (!taskTitle) return;

    try {
      const user = authService.getUser();
      if (!user) return;

      const dbTask = await taskService.createTask(user.id, {
        title: taskTitle,
        status: columnId,
        duration_minutes: 20
      });

      const newTask: Task = {
        id: dbTask.id,
        title: dbTask.title,
        duration: `${dbTask.duration_minutes || 20} Min`,
        completed: false,
        dbTask
      };

      setColumns(prev => prev.map(col => 
        col.id === columnId 
          ? { ...col, tasks: [...col.tasks, newTask] }
          : col
      ));

      setNewTaskInput(prev => ({ ...prev, [columnId]: '' }));
    } catch (error) {
      console.error('Failed to create task:', error);
    }
  };

  const clearAllTasks = async (columnId: string) => {
    try {
      const user = authService.getUser();
      if (!user) return;

      await taskService.clearColumnTasks(user.id, columnId);
      
      setColumns(prev => prev.map(col => 
        col.id === columnId 
          ? { ...col, tasks: [] }
          : col
      ));
    } catch (error) {
      console.error('Failed to clear tasks:', error);
    }
  };

  const toggleTaskCompletion = async (columnId: string, taskId: number) => {
    try {
      const user = authService.getUser();
      if (!user) return;

      await taskService.toggleTaskCompletion(taskId, user.id);
      
      setColumns(prev => prev.map(col => {
        if (col.id === columnId) {
          return {
            ...col,
            tasks: col.tasks.map(task => 
              task.id === taskId 
                ? { ...task, completed: !task.completed }
                : task
            )
          };
        }
        return col;
      }));
    } catch (error) {
      console.error('Failed to toggle task completion:', error);
    }
  };

  const getTaskCount = (columnId: string) => {
    const column = columns.find(col => col.id === columnId);
    return column?.tasks.length || 0;
  };

  const getProgressPercentage = (columnId: string) => {
    const column = columns.find(col => col.id === columnId);
    if (!column || column.tasks.length === 0) return 0;
    const completed = column.tasks.filter(t => t.completed).length;
    return Math.round((completed / column.tasks.length) * 100);
  };

  const getCompletedCount = (columnId: string) => {
    const column = columns.find(col => col.id === columnId);
    if (!column) return 0;
    return column.tasks.filter(t => t.completed).length;
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex-1 p-4 md:p-6 lg:p-8 bg-background min-h-screen overflow-x-hidden">
        <div className="max-w-7xl mx-auto">
          <h1 className="text-2xl md:text-3xl lg:text-4xl font-bold mb-4 md:mb-6 lg:mb-8 text-foreground">Tasks</h1>
          
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 md:gap-5 lg:gap-6">
            {loading ? (
              <div className="col-span-full flex items-center justify-center py-16">
                <p className="text-muted-foreground">Loading tasks...</p>
              </div>
            ) : (
              columns.map(column => (
                <div
                  key={column.id}
                  id={column.id}
                  className="bg-card rounded-xl md:rounded-2xl p-4 md:p-5 lg:p-6 shadow-sm border border-border flex flex-col h-[500px] md:h-[550px] lg:h-[600px] hover:shadow-lg transition-shadow"
                >
                {/* Column Header */}
                <div className="mb-3 md:mb-4">
                  <div className="flex items-center justify-between mb-2 md:mb-3">
                    <h2 className="text-lg md:text-xl font-bold text-foreground">
                      {column.title}
                    </h2>
                    {column.id === 'done' && getTaskCount(column.id) > 0 && (
                      <span className="text-xs text-muted-foreground">
                        {getTaskCount(column.id)} Task{getTaskCount(column.id) > 1 ? 's' : ''} this Month
                      </span>
                    )}
                  </div>

                  {/* Progress Bar - Fully Functional */}
                  {(column.id === 'thisweek' || column.id === 'today') && getTaskCount(column.id) > 0 && (
                    <div className="mb-3">
                      <div className="flex items-center gap-2 mb-1">
                        <Progress value={getProgressPercentage(column.id)} className="flex-1" />
                        <span className="text-xs text-muted-foreground min-w-[40px] text-right">
                          {getCompletedCount(column.id)}/{getTaskCount(column.id)}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground text-right">
                        {getProgressPercentage(column.id)}% Complete
                      </div>
                    </div>
                  )}

                  {/* Date badge for Done column */}
                  {column.id === 'done' && column.tasks.length > 0 && (
                    <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
                      <span>{column.tasks[0].date}</span>
                      <span>{getTaskCount(column.id)} Task{getTaskCount(column.id) > 1 ? 's' : ''}</span>
                    </div>
                  )}
                </div>

                {/* Add Task Input */}
                <div className="mb-3 md:mb-4">
                  <input
                    type="text"
                    data-column={column.id}
                    placeholder="Type task name and press Enter..."
                    value={newTaskInput[column.id] || ''}
                    onChange={(e) => setNewTaskInput(prev => ({ ...prev, [column.id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        addTask(column.id);
                      }
                    }}
                    className="w-full px-2 md:px-3 py-1.5 md:py-2 bg-muted/30 border border-border rounded-md outline-none text-xs md:text-sm placeholder:text-muted-foreground/70 focus:border-ring focus:ring-2 focus:ring-ring/20"
                  />
                  <div className="h-px bg-border/60 mt-2 md:mt-3" />
                </div>

                {/* Droppable Tasks List - Make entire area droppable */}
                <SortableContext
                  items={column.tasks.map(task => task.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <DroppableColumn column={column}>
                    {column.tasks.length === 0 ? (
                      <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
                        Drop tasks here or type above
                      </div>
                    ) : (
                      column.tasks.map((task, index) => (
                        <SortableTask
                          key={task.id}
                          task={task}
                          index={index}
                          columnId={column.id}
                          toggleTaskCompletion={toggleTaskCompletion}
                        />
                      ))
                    )}
                  </DroppableColumn>
                </SortableContext>

                {/* Clear All Button */}
                {column.tasks.length > 0 && (
                  <Button
                    onClick={() => clearAllTasks(column.id)}
                    variant="secondary"
                    className="mt-auto w-full text-xs md:text-sm py-2 md:py-2.5"
                    size="sm"
                  >
                    <CheckCircle2 className="w-4 h-4 md:w-5 md:h-5" />
                    <span>All Clear</span>
                  </Button>
                )}
              </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Drag Overlay */}
      <DragOverlay>
        {activeId ? (
          <div className="bg-secondary/30 dark:bg-muted/50 rounded-lg md:rounded-xl p-3 md:p-4 shadow-2xl border border-border/50 rotate-3 opacity-90">
            <div className="flex items-center gap-2">
              <GripVertical className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-semibold text-foreground">
                {columns.flatMap(col => col.tasks).find(task => task.id === activeId)?.title}
              </span>
            </div>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
};

export default TasksPage;
